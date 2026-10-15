import type { Prisma } from '@hubium/db';
import { excerpt, isEmptyRichText, sanitizeRichText } from '@hubium/editor/server';
import {
  type ActivityRef,
  defineAction,
  defineModule,
  defineQuery,
  type ModuleCtx,
  ModuleError,
  type ModuleFile,
  msg,
} from '@hubium/module-sdk';
import { bool, optionalNumber } from '@hubium/module-sdk/fields';
import { groupsWhere, userGroupIds, visibleGroupFilter } from '@hubium/module-sdk/groups';
import {
  aggregateRatings,
  scaleItems as courseScaleItems,
  inRatingWindow,
  ratingAggregates,
  ratingFields,
  scaleIdField,
} from '@hubium/module-sdk/ratings';
import { z } from 'zod';

// mod-forum: standard and Q&A forums with threaded posts, group modes, subscriptions,
// unread tracking, pin/lock, private replies and moderation; ratings of posts and a grade
// for the whole forum, each with its gradebook item.

export {
  aggregateRatings,
  type RatingAggregate,
  ratingAggregates,
} from '@hubium/module-sdk/ratings';

export const ForumSettings = z
  .object({
    type: z.enum(['general', 'qanda']).default('general'),
    subscription: z.enum(['optional', 'auto', 'forced', 'disabled']).default('optional'),
    maxAttachments: z.coerce.number().int().min(0).max(10).default(3),
    maxFileMB: z.coerce.number().int().min(1).max(100).default(10),
    allowPrivateReplies: bool(true),
    /** Minutes during which authors may edit or delete their own posts. */
    editMinutes: z.coerce
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60)
      .default(30),
    // ratings of posts (see @hubium/module-sdk/ratings)
    ...ratingFields,
    /** Students rate each other's posts too. */
    allowPeerRating: bool(false),
    /** Teachers grade each student's part in the whole forum. */
    wholeForumGrading: bool(false),
    gradeMax: z.coerce.number().min(1).max(10_000).default(100),
    gradeScaleId: scaleIdField,
    gradePass: optionalNumber(0, 10_000),
  })
  .refine((s) => !s.ratingFrom || !s.ratingTo || s.ratingTo > s.ratingFrom, {
    message: 'errors.common.ratingWindow',
    path: ['ratingTo'],
  })
  .refine((s) => s.ratingPass === undefined || s.ratingPass <= s.ratingMax, {
    message: 'errors.common.passGradeAboveMax',
    path: ['ratingPass'],
  })
  .refine((s) => s.gradePass === undefined || s.gradePass <= s.gradeMax, {
    message: 'errors.common.passGradeAboveMax',
    path: ['gradePass'],
  });

export type ForumSettingsT = z.output<typeof ForumSettings>;

type Db = Prisma.TransactionClient;
type Forum = ActivityRef<ForumSettingsT>;

const FileInput = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().default('application/octet-stream'),
  data: z.instanceof(Buffer),
});

function uid(ctx: ModuleCtx): string {
  if (ctx.actor.kind !== 'user') throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
  return ctx.actor.userId;
}

export async function isModerator(ctx: ModuleCtx, a: { id: string }): Promise<boolean> {
  return ctx.perm.can('mod.forum:moderate', a.id);
}

/**
 * Discussions the user may see: separate groups limit non-moderators to their groups
 * (plus "all participants" discussions). `null` means no restriction.
 */
async function forumGroupFilter(
  ctx: ModuleCtx,
  a: Forum,
  userId: string,
): Promise<string[] | null> {
  return visibleGroupFilter(ctx.db, a, userId, await isModerator(ctx, a));
}

/** Names of the discussions' groups; a group deleted since has none (its discussions keep
 *  its id and are seen only by those who see every group). */
async function groupNamesOf(ctx: ModuleCtx, ds: { groupId: string | null }[]) {
  const ids = [...new Set(ds.flatMap((d) => (d.groupId ? [d.groupId] : [])))];
  const rows = ids.length
    ? await ctx.db.group.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const names = new Map(rows.map((g) => [g.id, g.name]));
  return (d: { groupId: string | null }) => ({
    groupName: d.groupId ? (names.get(d.groupId) ?? null) : null,
    groupDeleted: !!d.groupId && !names.has(d.groupId),
  });
}

export async function canSeeDiscussion(
  ctx: ModuleCtx,
  a: Forum,
  d: { groupId: string | null },
  userId: string,
): Promise<boolean> {
  const groups = await forumGroupFilter(ctx, a, userId);
  return groups === null || d.groupId === null || groups.includes(d.groupId);
}

/** Q&A forums hide other replies until the user has replied in the discussion. */
export async function qandaLocked(
  ctx: ModuleCtx,
  a: Forum,
  discussionId: string,
  userId: string,
): Promise<boolean> {
  if (a.settings.type !== 'qanda' || (await isModerator(ctx, a))) return false;
  const mine = await ctx.db.forumPost.count({
    where: { discussionId, authorId: userId, parentId: { not: null }, deletedAt: null },
  });
  return mine === 0;
}

/** A post is visible to its author, the private recipient and moderators. */
export function postVisible(
  p: { authorId: string | null; privateToUserId: string | null },
  userId: string,
  moderator: boolean,
): boolean {
  return !p.privateToUserId || moderator || p.authorId === userId || p.privateToUserId === userId;
}

// ── ratings and the whole-forum grade ──────────────────────────────────────────

/** The grades of a scale, worst first; null for points (or a scale no longer there). */
export async function scaleItems(db: Db, a: Forum, id: string | null): Promise<string[] | null> {
  return courseScaleItems(db, a.courseId, id);
}

/** Does the user rate posts here: with the right to, or as a student with peer rating? */
export async function mayRate(ctx: ModuleCtx, a: Forum): Promise<boolean> {
  if (a.settings.ratingAggregate === 'none') return false;
  if (await ctx.perm.can('mod.forum:rate', a.id)) return true;
  return a.settings.allowPeerRating && ctx.perm.can('mod.forum:post', a.id);
}

/** A student's grade for ratings: the aggregate of the ratings of their posts. */
async function ratingGrade(db: Db, a: Forum, userId: string, scale: string[] | null) {
  const rows = await db.forumRating.findMany({
    where: {
      post: {
        authorId: userId,
        deletedAt: null,
        discussion: { activityId: a.id },
        createdAt: {
          ...(a.settings.ratingFrom ? { gte: new Date(a.settings.ratingFrom) } : {}),
          ...(a.settings.ratingTo ? { lte: new Date(a.settings.ratingTo) } : {}),
        },
      },
    },
    select: { value: true },
  });
  return aggregateRatings(
    a.settings.ratingAggregate,
    rows.map((r) => r.value),
    scale ? scale.length : a.settings.ratingMax,
    !!scale,
  );
}

/** Pushes the students' rating grades to the gradebook (item 0). */
export async function pushRatings(ctx: ModuleCtx, a: Forum, userIds: string[]) {
  if (a.settings.ratingAggregate === 'none' || !userIds.length) return;
  const scale = await scaleItems(ctx.db, a, a.settings.ratingScaleId);
  const grades = [];
  for (const userId of new Set(userIds))
    grades.push({ userId, itemNumber: 0, rawGrade: await ratingGrade(ctx.db, a, userId, scale) });
  await ctx.grades.setGrades(a.id, grades);
}

/** Everyone whose rating grade may change: authors of rated posts, and those graded. */
async function ratedUsers(db: Db, a: Forum) {
  const [posts, graded] = await Promise.all([
    db.forumPost.findMany({
      where: { discussion: { activityId: a.id }, ratings: { some: {} }, authorId: { not: null } },
      distinct: ['authorId'],
      select: { authorId: true },
    }),
    db.grade.findMany({
      where: { item: { activityId: a.id, itemNumber: 0 } },
      select: { userId: true },
    }),
  ]);
  return [
    ...new Set([
      ...posts.flatMap((p) => (p.authorId ? [p.authorId] : [])),
      ...graded.map((g) => g.userId),
    ]),
  ];
}

/** Pushes a student's whole-forum grade to the gradebook (item 1). */
async function pushForumGrade(ctx: ModuleCtx, a: Forum, userId: string) {
  if (!a.settings.wholeForumGrading) return;
  const g = await ctx.db.forumGrade.findUnique({
    where: { activityId_userId: { activityId: a.id, userId } },
  });
  await ctx.grades.setGrades(a.id, [
    {
      userId,
      itemNumber: 1,
      rawGrade: g?.grade === null || g?.grade === undefined ? null : Number(g.grade),
      feedback: g?.feedback ?? null,
      gradedById: g?.graderId ?? null,
    },
  ]);
}

/** The user's own whole-forum grade, once given. */
export async function readMyForumGrade(ctx: ModuleCtx, a: Forum) {
  if (!a.settings.wholeForumGrading) return null;
  const g = await ctx.db.forumGrade.findUnique({
    where: { activityId_userId: { activityId: a.id, userId: uid(ctx) } },
  });
  if (!g) return null;
  return {
    grade: g.grade === null ? null : Number(g.grade),
    feedback: g.feedback,
    gradedAt: g.gradedAt,
    scale: await scaleItems(ctx.db, a, a.settings.gradeScaleId),
    gradeMax: a.settings.gradeMax,
  };
}

/** A student's posts in the forum, newest first, for grading the whole forum. */
export async function readUserPosts(ctx: ModuleCtx, a: Forum, userId: string) {
  const rows = await ctx.db.forumPost.findMany({
    where: { authorId: userId, deletedAt: null, discussion: { activityId: a.id } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { discussion: { select: { id: true, title: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    discussionId: p.discussion.id,
    discussionTitle: p.discussion.title,
    parentId: p.parentId,
    contentHtml: p.contentHtml,
    privateToUserId: p.privateToUserId,
    createdAt: p.createdAt,
  }));
}

// ── reading (the forum page and the API queries share these) ────────────────────

export const DISCUSSIONS_PAGE = 30;

/** A page of the discussions the user may see, newest activity first, pinned on top. */
export async function readDiscussions(
  ctx: ModuleCtx,
  a: Forum,
  opts: { page?: number; pageSize?: number } = {},
) {
  const me = uid(ctx);
  const pageSize = opts.pageSize ?? DISCUSSIONS_PAGE;
  const page = Math.max(1, opts.page ?? 1);
  const moderator = await isModerator(ctx, a);
  const canStart =
    (await ctx.perm.can('mod.forum:startdiscussion', a.id)) &&
    (a.settings.type === 'general' || moderator);
  const groupFilter = await forumGroupFilter(ctx, a, me);
  const where = {
    activityId: a.id,
    ...(groupFilter ? { OR: [{ groupId: null }, { groupId: { in: groupFilter } }] } : {}),
  };
  const [discussions, total, sub, myGrade, canGrade] = await Promise.all([
    ctx.db.forumDiscussion.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { lastPostAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        author: { select: { name: true } },
        readStates: { where: { userId: me } },
      },
    }),
    ctx.db.forumDiscussion.count({ where }),
    subscriptionState(ctx, a, me),
    readMyForumGrade(ctx, a),
    a.settings.wholeForumGrading ? ctx.perm.can('mod.forum:grade', a.id) : false,
  ]);
  const unread = await Promise.all(
    discussions.map((d) =>
      ctx.db.forumPost.count({
        where: {
          discussionId: d.id,
          deletedAt: null,
          authorId: { not: me },
          ...(d.readStates[0] ? { createdAt: { gt: d.readStates[0].lastReadAt } } : {}),
          ...(moderator ? {} : { OR: [{ privateToUserId: null }, { privateToUserId: me }] }),
        },
      }),
    ),
  );
  const groupOf = await groupNamesOf(ctx, discussions);
  // Members choose one of their groups for a new discussion; moderators also post to all.
  const groups =
    a.groupMode === 'NONE'
      ? []
      : await ctx.db.group.findMany({
          where: moderator ? groupsWhere(a) : { id: { in: await userGroupIds(ctx.db, a, me) } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        });
  return {
    page,
    pageSize,
    total,
    canStart,
    moderator,
    subscribed: sub.forum,
    groups,
    /** The user's whole-forum grade, once given. */
    myGrade,
    /** The user grades students' part in the whole forum. */
    canGrade,
    items: discussions.map((d, i) => ({
      id: d.id,
      title: d.title,
      pinned: d.pinned,
      locked: d.locked,
      groupId: d.groupId,
      ...groupOf(d),
      authorName: d.author?.name ?? null,
      replies: Math.max(0, d.postCount - 1),
      unread: unread[i]!,
      lastPostAt: d.lastPostAt,
    })),
  };
}

export interface ForumPostView {
  id: string;
  parentId: string | null;
  authorId: string | null;
  /** null for a deleted account */
  authorName: string | null;
  /** empty for a deleted post */
  contentHtml: string;
  privateToUserId: string | null;
  deleted: boolean;
  editable: boolean;
  deletable: boolean;
  createdAt: Date;
  editedAt: Date | null;
  attachments: ModuleFile[];
  /** Ratings on: the aggregate the user may see, their own rating and whether they may rate. */
  rating: PostRating | null;
}

export interface PostRating {
  /** The aggregate of the post's ratings; null without ratings or when not to be seen. */
  aggregate: number | null;
  count: number;
  /** The user's own rating of the post. */
  mine: number | null;
  canRate: boolean;
  /** Who rated what, for those who see every rating. */
  raters: { name: string; value: number }[];
}

/**
 * A discussion with the posts the user may see, oldest first (a flat list; `parentId`
 * gives the tree). Private replies show only to their author, recipient and moderators;
 * in a Q&A forum other replies stay hidden until the user has replied. Reading does not
 * mark posts as read. `null` when the discussion is not there for this user.
 */
export async function readDiscussion(ctx: ModuleCtx, a: Forum, discussionId: string) {
  const me = uid(ctx);
  const d = await ctx.db.forumDiscussion.findUnique({ where: { id: discussionId } });
  if (!d || d.activityId !== a.id || !(await canSeeDiscussion(ctx, a, d, me))) return null;
  const moderator = await isModerator(ctx, a);
  const [canPost, locked, sub] = await Promise.all([
    ctx.perm.can('mod.forum:post', a.id),
    qandaLocked(ctx, a, d.id, me),
    subscriptionState(ctx, a, me, d.id),
  ]);
  const myGroups = d.groupId && !moderator ? await userGroupIds(ctx.db, a, me) : [];
  const inGroup = !d.groupId || moderator || myGroups.includes(d.groupId);
  const [rows, files] = await Promise.all([
    ctx.db.forumPost.findMany({
      where: { discussionId: d.id },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { name: true } } },
    }),
    ctx.files.list(a.id, 'attachment'),
  ]);
  const visible = rows.filter(
    (p) =>
      postVisible(p, me, moderator) &&
      // Q&A: until the user replies, only the question and their own posts are shown
      (!locked || p.parentId === null || p.authorId === me),
  );
  const shown = new Set(visible.map((p) => p.id));
  const hasReplies = new Set(visible.map((p) => p.parentId).filter((x) => x && shown.has(x)));
  const now = Date.now();
  // ratings: the aggregate of one's own posts (viewrating) or anyone's (viewanyrating),
  // who rated what (viewallratings), and a select for those who rate
  const s = a.settings;
  const ratingsOn = s.ratingAggregate !== 'none';
  const [viewOwn, viewAny, viewAll, rater, ratingScale] = ratingsOn
    ? await Promise.all([
        ctx.perm.can('mod.forum:viewrating', a.id),
        ctx.perm.can('mod.forum:viewanyrating', a.id),
        ctx.perm.can('mod.forum:viewallratings', a.id),
        mayRate(ctx, a),
        scaleItems(ctx.db, a, s.ratingScaleId),
      ])
    : [false, false, false, false, null];
  const ratings = ratingsOn
    ? await ctx.db.forumRating.findMany({
        where: { postId: { in: [...shown] } },
        include: { rater: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const ratingOf = (p: (typeof visible)[number]): PostRating | null => {
    if (!ratingsOn || p.deletedAt) return null;
    const rs = ratings.filter((r) => r.postId === p.id);
    const see = p.authorId === me ? viewOwn : viewAny;
    return {
      aggregate: see
        ? aggregateRatings(
            s.ratingAggregate,
            rs.map((r) => r.value),
            ratingScale ? ratingScale.length : s.ratingMax,
            !!ratingScale,
          )
        : null,
      count: see ? rs.length : 0,
      mine: rs.find((r) => r.raterId === me)?.value ?? null,
      canRate: rater && !!p.authorId && p.authorId !== me && inRatingWindow(p.createdAt, s),
      raters: viewAll ? rs.map((r) => ({ name: r.rater.name, value: r.value })) : [],
    };
  };
  const posts: ForumPostView[] = visible.map((p) => {
    const editable =
      !p.deletedAt &&
      (moderator ||
        (p.authorId === me && now - p.createdAt.getTime() <= a.settings.editMinutes * 60_000));
    return {
      id: p.id,
      parentId: p.parentId,
      authorId: p.authorId,
      authorName: p.author?.name ?? null,
      contentHtml: p.deletedAt ? '' : p.contentHtml,
      privateToUserId: p.privateToUserId,
      deleted: !!p.deletedAt,
      editable,
      deletable: editable && (moderator || !hasReplies.has(p.id)),
      createdAt: p.createdAt,
      editedAt: p.editedAt,
      attachments: p.deletedAt ? [] : files.filter((f) => f.itemId === p.id),
      rating: ratingOf(p),
    };
  });
  return {
    discussion: {
      id: d.id,
      title: d.title,
      pinned: d.pinned,
      locked: d.locked,
      groupId: d.groupId,
      ...(await groupNamesOf(ctx, [d]))(d),
      createdAt: d.createdAt,
    },
    moderator,
    canReply: canPost && inGroup && (!d.locked || moderator),
    canReplyPrivately: moderator && a.settings.allowPrivateReplies,
    qandaLocked: locked,
    subscribed: sub.discussion,
    /** Ratings on: how they aggregate, and the scale (or the most points) they take. */
    rating: ratingsOn
      ? { aggregate: s.ratingAggregate, scale: ratingScale, max: s.ratingMax }
      : null,
    posts,
  };
}

const DiscussionOut = z.object({
  id: z.string().uuid(),
  title: z.string(),
  pinned: z.boolean(),
  locked: z.boolean(),
  groupId: z.string().uuid().nullable(),
  groupName: z.string().nullable(),
  /** Its group was deleted: only those who see every group see it. */
  groupDeleted: z.boolean(),
});
const FileOut = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  url: z.string(),
});

async function loadDiscussion(ctx: ModuleCtx, a: Forum, discussionId: string) {
  const d = await ctx.db.forumDiscussion.findUnique({ where: { id: discussionId } });
  if (!d || d.activityId !== a.id)
    throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.noDiscussion'));
  if (!(await canSeeDiscussion(ctx, a, d, uid(ctx))))
    throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.noDiscussion'));
  return d;
}

async function storeAttachments(
  ctx: ModuleCtx,
  a: Forum,
  postId: string,
  files: z.output<typeof FileInput>[],
) {
  if (files.length > a.settings.maxAttachments) {
    throw new ModuleError(
      'BAD_REQUEST',
      msg('mod.forum.errors.tooManyAttachments', { n: a.settings.maxAttachments }),
    );
  }
  for (const f of files) {
    await ctx.files.store(
      a.id,
      'attachment',
      { ...f, itemId: postId },
      { maxBytes: a.settings.maxFileMB * 1024 * 1024 },
    );
  }
}

/** Users who receive a notification about a new post. */
export async function subscribers(
  ctx: ModuleCtx,
  a: Forum,
  d: { id: string; groupId: string | null },
): Promise<string[]> {
  const mode = a.settings.subscription;
  if (mode === 'disabled') return [];
  const readers = await ctx.perm.usersWithCap('mod.forum:post', a.id, {
    groupId: a.groupMode === 'SEPARATE' && d.groupId ? d.groupId : undefined,
  });
  if (mode === 'forced') return readers;
  const subs = await ctx.db.forumSubscription.findMany({ where: { activityId: a.id } });
  const forumLevel = new Map(
    subs.filter((s) => s.discussionId === null).map((s) => [s.userId, s.subscribed]),
  );
  const discLevel = new Map(
    subs.filter((s) => s.discussionId === d.id).map((s) => [s.userId, s.subscribed]),
  );
  return readers.filter((u) => {
    const disc = discLevel.get(u);
    if (disc !== undefined) return disc;
    return forumLevel.get(u) ?? mode === 'auto';
  });
}

/** Authors follow the discussions they post in unless they opted out. */
async function followDiscussion(ctx: ModuleCtx, a: Forum, discussionId: string, userId: string) {
  if (a.settings.subscription === 'disabled' || a.settings.subscription === 'forced') return;
  // an opt-out already there stays
  await ctx.db.forumSubscription.createMany({
    data: [{ activityId: a.id, userId, discussionId, subscribed: true }],
    skipDuplicates: true,
  });
}

async function notifyPost(
  ctx: ModuleCtx,
  a: Forum,
  d: { id: string; groupId: string | null; title: string },
  post: { id: string; contentHtml: string; privateToUserId: string | null },
  author: string,
) {
  const recipients = post.privateToUserId ? [post.privateToUserId] : await subscribers(ctx, a, d);
  const user = await ctx.db.user.findUniqueOrThrow({
    where: { id: author },
    select: { name: true },
  });
  // In Q&A forums replies are hidden from people who have not replied yet: they still
  // get the notification, but without the text.
  const hideText = a.settings.type === 'qanda';
  await ctx.notify.send(recipients, {
    type: 'forum.post',
    title: {
      key: 'mod.forum.notify.postTitle',
      values: { user: user.name, title: d.title, forum: a.name },
    },
    body: hideText ? '' : excerpt(post.contentHtml, 300),
    url: `/course/${a.courseId}/a/${a.id}?d=${d.id}#p-${post.id}`,
    courseId: a.courseId,
    contextId: a.id,
    data: { discussionId: d.id, postId: post.id },
  });
}

async function markRead(db: Db, discussionId: string, userId: string, at: Date) {
  await db.forumReadState.upsert({
    where: { userId_discussionId: { userId, discussionId } },
    create: { userId, discussionId, lastReadAt: at },
    update: { lastReadAt: at },
  });
}

async function recount(db: Db, discussionId: string) {
  const [count, last] = await Promise.all([
    db.forumPost.count({ where: { discussionId, deletedAt: null } }),
    db.forumPost.findFirst({
      where: { discussionId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);
  await db.forumDiscussion.update({
    where: { id: discussionId },
    data: { postCount: count, ...(last ? { lastPostAt: last.createdAt } : {}) },
  });
}

/** Per-user post counts for completion rules. */
export async function postStats(db: Db, activityId: string, userId: string) {
  const [discussions, replies] = await Promise.all([
    db.forumPost.count({
      where: { authorId: userId, parentId: null, deletedAt: null, discussion: { activityId } },
    }),
    db.forumPost.count({
      where: {
        authorId: userId,
        parentId: { not: null },
        deletedAt: null,
        discussion: { activityId },
      },
    }),
  ]);
  return { discussions, replies, posts: discussions + replies };
}

const count = z.coerce.number().int().min(0).max(100).default(0);

export const forum = defineModule<ForumSettingsT>({
  key: 'forum',
  archetype: 'activity',
  icon: 'MessagesSquare',
  supports: { grading: true, groups: true, viewCompletion: true, backup: true },
  reset: {
    // discussions take their posts, ratings, subscriptions and read states with them
    async userData(ctx, a) {
      await ctx.db.forumDiscussion.deleteMany({ where: { activityId: a.id } });
      await ctx.db.forumSubscription.deleteMany({ where: { activityId: a.id } });
      await ctx.db.forumGrade.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      const [posts, ratingsGiven, grades] = await Promise.all([
        ctx.db.forumPost.findMany({
          where: { authorId: userId, deletedAt: null },
          select: {
            id: true,
            createdAt: true,
            contentHtml: true,
            discussion: { select: { title: true } },
          },
          orderBy: { createdAt: 'asc' },
        }),
        ctx.db.forumRating.findMany({
          where: { raterId: userId },
          select: { postId: true, value: true, createdAt: true },
        }),
        ctx.db.forumGrade.findMany({
          where: { userId },
          select: { activityId: true, grade: true, feedback: true, gradedAt: true },
        }),
      ]);
      return { posts, ratingsGiven, grades };
    },
    async erase(ctx, userId) {
      // Keep thread structure for other participants; drop the author's words and files.
      const posts = await ctx.db.forumPost.findMany({
        where: { authorId: userId },
        select: { id: true, discussion: { select: { activityId: true } } },
      });
      for (const p of posts) {
        const files = await ctx.files.list(p.discussion.activityId, 'attachment', p.id);
        if (files.length)
          await ctx.files.remove(
            p.discussion.activityId,
            'attachment',
            files.map((f) => f.id),
            p.id,
          );
      }
      await ctx.db.forumPost.updateMany({
        where: { authorId: userId },
        data: { contentHtml: '', deletedAt: ctx.now },
      });
      // the user's ratings go; the grades of those they rated follow
      const rated = await ctx.db.forumRating.findMany({
        where: { raterId: userId },
        select: {
          post: { select: { authorId: true, discussion: { select: { activityId: true } } } },
        },
      });
      await ctx.db.forumRating.deleteMany({ where: { raterId: userId } });
      for (const activityId of new Set(rated.map((r) => r.post.discussion.activityId))) {
        const act = await ctx.db.activity.findUnique({ where: { id: activityId } });
        const settings = act ? ForumSettings.safeParse(act.settings) : null;
        if (!act || !settings?.success) continue;
        const a = { ...(act as unknown as Forum), settings: settings.data };
        await pushRatings(
          ctx,
          a,
          rated.flatMap((r) =>
            r.post.discussion.activityId === activityId && r.post.authorId ? [r.post.authorId] : [],
          ),
        );
      }
      await ctx.db.forumSubscription.deleteMany({ where: { userId } });
      await ctx.db.forumReadState.deleteMany({ where: { userId } });
    },
  },
  backup: { userFileAreas: ['attachment'] },
  settings: {
    schema: ForumSettings as unknown as z.ZodType<ForumSettingsT>,
    defaults: () => ForumSettings.parse({}),
  },
  notifications: { post: { email: 'IMMEDIATE' }, graded: { email: 'IMMEDIATE' } },
  // item 0: the ratings of the student's posts; item 1: the grade for the whole forum
  grading: {
    items: (a) => [
      ...(a.settings.ratingAggregate !== 'none'
        ? [
            {
              itemNumber: 0,
              name: 'Rating',
              nameKey: 'mod.forum.gradeItem.rating',
              gradeMax: a.settings.ratingMax,
              gradePass: a.settings.ratingPass,
              scaleId: a.settings.ratingScaleId,
            },
          ]
        : []),
      ...(a.settings.wholeForumGrading
        ? [
            {
              itemNumber: 1,
              name: 'Whole forum',
              nameKey: 'mod.forum.gradeItem.whole',
              gradeMax: a.settings.gradeMax,
              gradePass: a.settings.gradePass,
              scaleId: a.settings.gradeScaleId,
            },
          ]
        : []),
    ],
  },
  completion: {
    schema: z.object({ posts: count, discussions: count, replies: count }),
    async evaluate(ctx, a, userId, rules) {
      const r = rules as { posts: number; discussions: number; replies: number };
      const s = await postStats(ctx.db, a.id, userId);
      return s.posts >= r.posts && s.discussions >= r.discussions && s.replies >= r.replies
        ? 'complete'
        : 'incomplete';
    },
  },
  files: {
    attachment: {
      async canRead(ctx, a, f) {
        if (ctx.actor.kind !== 'user') return false;
        const post = await ctx.db.forumPost.findUnique({
          where: { id: f.itemId },
          include: { discussion: { select: { groupId: true } } },
        });
        if (!post || post.deletedAt) return false;
        const moderator = await isModerator(ctx, a);
        return (
          postVisible(post, ctx.actor.userId, moderator) &&
          (await canSeeDiscussion(ctx, a as Forum, post.discussion, ctx.actor.userId))
        );
      },
    },
  },
  extractText: (a) => a.name,
  queries: {
    discussions: defineQuery({
      summary: 'Discussions the user may see, pinned first, with unread counts',
      input: z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(DISCUSSIONS_PAGE),
      }),
      output: z.object({
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        canStart: z.boolean(),
        moderator: z.boolean(),
        subscribed: z.boolean(),
        groups: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
        myGrade: z
          .object({
            grade: z.number().nullable().describe('points, or a 1-based scale position'),
            feedback: z.string(),
            gradedAt: z.string(),
            scale: z.array(z.string()).nullable(),
            gradeMax: z.number(),
          })
          .nullable()
          .describe('whole-forum grading: your grade, once given'),
        canGrade: z.boolean().describe('whole-forum grading: you grade students'),
        items: z.array(
          DiscussionOut.extend({
            authorName: z.string().nullable(),
            replies: z.number(),
            unread: z.number(),
            lastPostAt: z.string(),
          }),
        ),
      }),
      handler: (ctx, a, input) => readDiscussions(ctx, a as Forum, input),
    }),
    discussion: defineQuery({
      summary: 'A discussion and the posts the user may see (flat, parentId gives the tree)',
      input: z.object({ discussionId: z.string().uuid() }),
      output: z.object({
        discussion: DiscussionOut.extend({ createdAt: z.string() }),
        moderator: z.boolean(),
        canReply: z.boolean(),
        canReplyPrivately: z.boolean(),
        qandaLocked: z.boolean().describe('Q&A forum: other replies show once the user replied'),
        subscribed: z.boolean(),
        rating: z
          .object({
            aggregate: z.enum(ratingAggregates),
            scale: z.array(z.string()).nullable().describe('ratings on a scale, worst first'),
            max: z.number().describe('ratings in points: 0..max'),
          })
          .nullable()
          .describe('ratings on'),
        posts: z.array(
          z.object({
            id: z.string().uuid(),
            parentId: z.string().uuid().nullable(),
            authorId: z.string().uuid().nullable(),
            authorName: z.string().nullable(),
            contentHtml: z.string(),
            privateToUserId: z.string().uuid().nullable(),
            deleted: z.boolean(),
            editable: z.boolean(),
            deletable: z.boolean(),
            createdAt: z.string(),
            editedAt: z.string().nullable(),
            attachments: z.array(FileOut),
            rating: z
              .object({
                aggregate: z.number().nullable(),
                count: z.number(),
                mine: z.number().nullable(),
                canRate: z.boolean(),
                raters: z.array(z.object({ name: z.string(), value: z.number() })),
              })
              .nullable(),
          }),
        ),
      }),
      async handler(ctx, a, { discussionId }) {
        const r = await readDiscussion(ctx, a as Forum, discussionId);
        if (!r) throw new ModuleError('NOT_FOUND', msg('mod.forum.errors.noDiscussion'));
        return r;
      },
    }),
    userPosts: defineQuery({
      summary:
        "Whole-forum grading: a student's posts in the forum, newest first, with their grade",
      capability: 'mod.forum:grade',
      input: z.object({ userId: z.string().uuid() }),
      output: z.object({
        posts: z.array(
          z.object({
            id: z.string().uuid(),
            discussionId: z.string().uuid(),
            discussionTitle: z.string(),
            parentId: z.string().uuid().nullable(),
            contentHtml: z.string(),
            privateToUserId: z.string().uuid().nullable(),
            createdAt: z.string(),
          }),
        ),
        grade: z
          .object({ grade: z.number().nullable(), feedback: z.string(), gradedAt: z.string() })
          .nullable(),
      }),
      async handler(ctx, ref, { userId }) {
        const a = ref as Forum;
        const g = await ctx.db.forumGrade.findUnique({
          where: { activityId_userId: { activityId: a.id, userId } },
        });
        return {
          posts: await readUserPosts(ctx, a, userId),
          grade: g
            ? {
                grade: g.grade === null ? null : Number(g.grade),
                feedback: g.feedback,
                gradedAt: g.gradedAt,
              }
            : null,
        };
      },
    }),
  },
  actions: {
    rate: defineAction({
      summary:
        'Rate a post (null takes your rating back): points 0..max, or a 1-based position on the forum’s scale',
      input: z.object({ postId: z.string().uuid(), value: z.number().int().nullable() }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        if (a.settings.ratingAggregate === 'none')
          throw new ModuleError('CONFLICT', msg('mod.forum.errors.ratingsOff'));
        const post = await ctx.db.forumPost.findUnique({ where: { id: input.postId } });
        if (!post || post.deletedAt)
          throw new ModuleError('NOT_FOUND', msg('mod.forum.errors.noPost'));
        await loadDiscussion(ctx, a, post.discussionId);
        const moderator = await isModerator(ctx, a);
        const hidden =
          !postVisible(post, me, moderator) ||
          (!!post.parentId &&
            post.authorId !== me &&
            (await qandaLocked(ctx, a, post.discussionId, me)));
        if (hidden) throw new ModuleError('NOT_FOUND', msg('mod.forum.errors.noPost'));
        if (
          !(await mayRate(ctx, a)) ||
          !post.authorId ||
          post.authorId === me ||
          !inRatingWindow(post.createdAt, a.settings)
        )
          throw new ModuleError('FORBIDDEN', msg('mod.forum.errors.cannotRate'));
        if (input.value !== null) {
          const scale = await scaleItems(ctx.db, a, a.settings.ratingScaleId);
          const [lo, hi] = scale ? [1, scale.length] : [0, a.settings.ratingMax];
          if (input.value < lo || input.value > hi)
            throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.ratingRange', { lo, hi }));
          await ctx.db.forumRating.upsert({
            where: { postId_raterId: { postId: post.id, raterId: me } },
            create: { postId: post.id, raterId: me, value: input.value },
            update: { value: input.value },
          });
        } else await ctx.db.forumRating.deleteMany({ where: { postId: post.id, raterId: me } });
        await pushRatings(ctx, a, [post.authorId]);
        return { ok: true };
      },
    }),
    gradeUser: defineAction({
      summary:
        "Grade a student's part in the whole forum (points, or a 1-based scale position; null clears) with feedback",
      capability: 'mod.forum:grade',
      input: z.object({
        userId: z.string().uuid(),
        grade: z.number().nullable(),
        feedback: z.string().max(200_000).default(''),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        if (!a.settings.wholeForumGrading)
          throw new ModuleError('CONFLICT', msg('mod.forum.errors.notWholeForum'));
        const enrolled = await ctx.db.enrolment.findFirst({
          where: { courseId: a.courseId, userId: input.userId },
        });
        if (!enrolled) throw new ModuleError('NOT_FOUND', msg('errors.common.notEnrolled'));
        if (input.grade !== null) {
          const scale = await scaleItems(ctx.db, a, a.settings.gradeScaleId);
          if (scale) {
            if (!Number.isInteger(input.grade) || input.grade < 1 || input.grade > scale.length)
              throw new ModuleError('BAD_REQUEST', msg('errors.grades.chooseGradeScale'));
          } else if (input.grade < 0 || input.grade > a.settings.gradeMax)
            throw new ModuleError(
              'BAD_REQUEST',
              msg('mod.forum.errors.gradeRange', { max: a.settings.gradeMax }),
            );
        }
        const data = {
          grade: input.grade,
          feedback: sanitizeRichText(input.feedback),
          graderId: uid(ctx),
          gradedAt: ctx.now,
        };
        await ctx.db.forumGrade.upsert({
          where: { activityId_userId: { activityId: a.id, userId: input.userId } },
          create: { activityId: a.id, userId: input.userId, ...data },
          update: data,
        });
        await pushForumGrade(ctx, a, input.userId);
        await ctx.notify.send([input.userId], {
          type: 'forum.graded',
          title: { key: 'mod.forum.notify.gradedTitle', values: { name: a.name } },
          url: `/course/${a.courseId}/a/${a.id}`,
          courseId: a.courseId,
          contextId: a.id,
        });
        await ctx.log('forum.graded', {
          activityId: a.id,
          userId: input.userId,
          grade: input.grade,
        });
        return { ok: true };
      },
    }),
    startDiscussion: defineAction({
      summary: 'Start a discussion, optionally in a group, with attachments',
      capability: 'mod.forum:startdiscussion',
      input: z.object({
        title: z.string().trim().min(1).max(255),
        message: z.string().max(200_000),
        groupId: z.string().uuid().nullish(),
        pinned: z.boolean().default(false),
        files: z.array(FileInput).max(10).default([]),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        const moderator = await isModerator(ctx, a);
        if (a.settings.type === 'qanda' && !moderator) {
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.qandaTeachersOnly'));
        }
        const html = sanitizeRichText(input.message);
        if (isEmptyRichText(html))
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.messageEmpty'));
        let groupId = input.groupId ?? null;
        if (a.groupMode !== 'NONE' && !moderator) {
          const mine = await userGroupIds(ctx.db, a, me);
          if (groupId && !mine.includes(groupId))
            throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.notMember'));
          if (!groupId && mine.length) groupId = mine[0]!;
        }
        if (groupId) {
          const g = await ctx.db.group.findFirst({
            where: { id: groupId, ...groupsWhere(a) },
          });
          if (!g) throw new ModuleError('BAD_REQUEST', msg('errors.common.unknownGroup'));
        }
        const d = await ctx.db.forumDiscussion.create({
          data: {
            activityId: a.id,
            groupId,
            authorId: me,
            title: input.title,
            pinned: moderator && input.pinned,
            lastPostAt: ctx.now,
            postCount: 1,
          },
        });
        const post = await ctx.db.forumPost.create({
          data: { discussionId: d.id, authorId: me, contentHtml: html, createdAt: ctx.now },
        });
        await storeAttachments(ctx, a, post.id, input.files);
        await followDiscussion(ctx, a, d.id, me);
        await markRead(ctx.db, d.id, me, ctx.now);
        await ctx.log('forum.discussion.created', { activityId: a.id, discussionId: d.id });
        await ctx.completion.recompute(a.id, me);
        await notifyPost(ctx, a, d, post, me);
        return { discussionId: d.id, postId: post.id };
      },
    }),
    reply: defineAction({
      summary: 'Reply to a post (privately to its author when `private`)',
      capability: 'mod.forum:post',
      input: z.object({
        postId: z.string().uuid(),
        message: z.string().max(200_000),
        private: z.boolean().default(false),
        files: z.array(FileInput).max(10).default([]),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        const parent = await ctx.db.forumPost.findUnique({ where: { id: input.postId } });
        if (!parent || parent.deletedAt)
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.noPost'));
        const d = await loadDiscussion(ctx, a, parent.discussionId);
        const moderator = await isModerator(ctx, a);
        if (d.locked && !moderator)
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.locked'));
        if (!postVisible(parent, me, moderator))
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.noPost'));
        if (a.groupMode !== 'NONE' && d.groupId && !moderator) {
          const mine = await userGroupIds(ctx.db, a, me);
          if (!mine.includes(d.groupId))
            throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.notMember'));
        }
        let privateTo: string | null = null;
        if (input.private) {
          if (!a.settings.allowPrivateReplies || !moderator) {
            throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.noPrivateReplies'));
          }
          privateTo = parent.authorId;
        } else if (parent.privateToUserId) {
          // replying inside a private thread stays private between the two people
          privateTo = parent.authorId === me ? parent.privateToUserId : parent.authorId;
        }
        const html = sanitizeRichText(input.message);
        if (isEmptyRichText(html))
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.messageEmpty'));
        const post = await ctx.db.forumPost.create({
          data: {
            discussionId: d.id,
            parentId: parent.id,
            authorId: me,
            contentHtml: html,
            privateToUserId: privateTo,
            createdAt: ctx.now,
          },
        });
        await storeAttachments(ctx, a, post.id, input.files);
        await recount(ctx.db, d.id);
        await followDiscussion(ctx, a, d.id, me);
        await markRead(ctx.db, d.id, me, ctx.now);
        await ctx.completion.recompute(a.id, me);
        await notifyPost(ctx, a, d, post, me);
        return { postId: post.id };
      },
    }),
    editPost: defineAction({
      summary: 'Change the text of a post: your own within the edit window, any as a moderator',
      input: z.object({ postId: z.string().uuid(), message: z.string().max(200_000) }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        const post = await ctx.db.forumPost.findUnique({ where: { id: input.postId } });
        if (!post || post.deletedAt)
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.noPost'));
        await loadDiscussion(ctx, a, post.discussionId);
        const moderator = await isModerator(ctx, a);
        const withinWindow =
          ctx.now.getTime() - post.createdAt.getTime() <= a.settings.editMinutes * 60_000;
        if (!moderator && (post.authorId !== me || !withinWindow)) {
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.editTimeOver'));
        }
        const html = sanitizeRichText(input.message);
        if (isEmptyRichText(html))
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.messageEmpty'));
        await ctx.db.forumPost.update({
          where: { id: post.id },
          data: { contentHtml: html, editedAt: ctx.now },
        });
        return { ok: true };
      },
    }),
    deletePost: defineAction({
      summary: 'Delete a post (the first post deletes the whole discussion)',
      input: z.object({ postId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        const post = await ctx.db.forumPost.findUnique({
          where: { id: input.postId },
          include: { _count: { select: { replies: { where: { deletedAt: null } } } } },
        });
        if (!post || post.deletedAt)
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.noPost'));
        const d = await loadDiscussion(ctx, a, post.discussionId);
        const moderator = await isModerator(ctx, a);
        const withinWindow =
          ctx.now.getTime() - post.createdAt.getTime() <= a.settings.editMinutes * 60_000;
        if (!moderator && (post.authorId !== me || !withinWindow || post._count.replies > 0)) {
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.cannotDelete'));
        }
        if (!post.parentId) {
          // the discussion's posts go with their ratings: their authors' grades change
          const authors = await ctx.db.forumPost.findMany({
            where: { discussionId: d.id, authorId: { not: null } },
            distinct: ['authorId'],
            select: { authorId: true },
          });
          await ctx.db.forumDiscussion.delete({ where: { id: d.id } });
          await ctx.log('forum.discussion.deleted', { activityId: a.id, discussionId: d.id });
          if (post.authorId) await ctx.completion.recompute(a.id, post.authorId);
          await pushRatings(
            ctx,
            a,
            authors.flatMap((x) => (x.authorId ? [x.authorId] : [])),
          );
          return { discussionDeleted: true };
        }
        await ctx.db.forumPost.update({ where: { id: post.id }, data: { deletedAt: ctx.now } });
        await recount(ctx.db, d.id);
        await ctx.log('forum.post.deleted', { activityId: a.id, postId: post.id });
        if (post.authorId) {
          await ctx.completion.recompute(a.id, post.authorId);
          await pushRatings(ctx, a, [post.authorId]);
        }
        return { discussionDeleted: false };
      },
    }),
    moderate: defineAction({
      summary: 'Pin or lock a discussion',
      capability: 'mod.forum:moderate',
      input: z.object({
        discussionId: z.string().uuid(),
        pinned: z.boolean().optional(),
        locked: z.boolean().optional(),
      }),
      async handler(ctx, ref, input) {
        const d = await loadDiscussion(ctx, ref as Forum, input.discussionId);
        await ctx.db.forumDiscussion.update({
          where: { id: d.id },
          data: {
            ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
            ...(input.locked !== undefined ? { locked: input.locked } : {}),
          },
        });
        return { ok: true };
      },
    }),
    subscribe: defineAction({
      summary: 'Subscribe to the forum (no discussionId) or one discussion, or unsubscribe',
      input: z.object({ discussionId: z.string().uuid().nullish(), subscribed: z.boolean() }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        if (a.settings.subscription === 'disabled' || a.settings.subscription === 'forced') {
          throw new ModuleError('BAD_REQUEST', msg('mod.forum.errors.subscriptionFixed'));
        }
        const discussionId = input.discussionId ?? null;
        if (discussionId) await loadDiscussion(ctx, a, discussionId);
        // one row each, also when two clicks arrive together: the forum-level row by its
        // partial unique index (nulls differ in the composite key)
        if (discussionId)
          await ctx.db.forumSubscription.upsert({
            where: {
              activityId_userId_discussionId: { activityId: a.id, userId: me, discussionId },
            },
            create: { activityId: a.id, userId: me, discussionId, subscribed: input.subscribed },
            update: { subscribed: input.subscribed },
          });
        else
          await ctx.db.$executeRaw`
            INSERT INTO "ForumSubscription" ("id", "activityId", "userId", "discussionId", "subscribed")
            VALUES (gen_random_uuid(), ${a.id}::uuid, ${me}::uuid, NULL, ${input.subscribed})
            ON CONFLICT ("activityId", "userId") WHERE "discussionId" IS NULL
            DO UPDATE SET "subscribed" = EXCLUDED."subscribed"`;
        if (!discussionId) {
          // forum-level choice resets per-discussion overrides
          await ctx.db.forumSubscription.deleteMany({
            where: { activityId: a.id, userId: me, discussionId: { not: null } },
          });
        }
        return { ok: true };
      },
    }),
    markRead: defineAction({
      summary: 'Mark every post of a discussion read',
      input: z.object({ discussionId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const d = await loadDiscussion(ctx, ref as Forum, input.discussionId);
        await markRead(ctx.db, d.id, uid(ctx), ctx.now);
        return { ok: true };
      },
    }),
  },
  lifecycle: {
    // new rating settings change every rating grade; items come and go with the settings
    async onUpdate(ctx, ref, prev) {
      const a = ref as Forum;
      const s = a.settings;
      const keys = [
        'ratingAggregate',
        'ratingScaleId',
        'ratingMax',
        'ratingFrom',
        'ratingTo',
      ] as const;
      const ratingsChanged = keys.some((k) => s[k] !== prev[k]);
      if (!ratingsChanged && s.wholeForumGrading === prev.wholeForumGrading) return;
      await ctx.grades.syncItems(a.id);
      if (ratingsChanged) await pushRatings(ctx, a, await ratedUsers(ctx.db, a));
      if (s.wholeForumGrading && !prev.wholeForumGrading)
        for (const g of await ctx.db.forumGrade.findMany({
          where: { activityId: a.id },
          select: { userId: true },
        }))
          await pushForumGrade(ctx, a, g.userId);
    },
    async onUserUnenrolled(ctx, courseId, userId) {
      await ctx.db.forumSubscription.deleteMany({ where: { userId, activity: { courseId } } });
    },
  },
});

/** Is the user subscribed to the forum / a discussion (for the toggle buttons)? */
export async function subscriptionState(
  ctx: ModuleCtx,
  a: Forum,
  userId: string,
  discussionId?: string,
): Promise<{ forum: boolean; discussion: boolean }> {
  const mode = a.settings.subscription;
  if (mode === 'disabled') return { forum: false, discussion: false };
  if (mode === 'forced') return { forum: true, discussion: true };
  const subs = await ctx.db.forumSubscription.findMany({
    where: { activityId: a.id, userId },
  });
  const forum = subs.find((s) => s.discussionId === null)?.subscribed ?? mode === 'auto';
  const disc = discussionId ? subs.find((s) => s.discussionId === discussionId) : undefined;
  return { forum, discussion: disc?.subscribed ?? forum };
}

export const forumModules = [forum];
