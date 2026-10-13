import type { Prisma } from '@hubium/db';
import { excerpt, isEmptyRichText, sanitizeRichText } from '@hubium/editor/server';
import { type ActivityRef, defineAction, defineModule, type ModuleCtx } from '@hubium/module-sdk';
import { bool } from '@hubium/module-sdk/fields';
import { z } from 'zod';

// mod-forum: standard and Q&A forums with threaded posts, group modes, subscriptions,
// unread tracking, pin/lock, private replies and moderation.

export const ForumSettings = z.object({
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
  if (ctx.actor.kind !== 'user') throw new Error('Sign in required');
  return ctx.actor.userId;
}

export async function isModerator(ctx: ModuleCtx, a: { id: string }): Promise<boolean> {
  return ctx.perm.can('mod.forum:moderate', a.id);
}

/** The forum's groups: those of its grouping when it has one, else all of the course. */
export function forumGroupsWhere(a: { courseId: string; groupingId: string | null }) {
  return {
    courseId: a.courseId,
    ...(a.groupingId ? { groupings: { some: { groupingId: a.groupingId } } } : {}),
  };
}

/** Groups of the user among the forum's groups. */
export async function userGroupIds(
  db: Db,
  a: { courseId: string; groupingId: string | null },
  userId: string,
): Promise<string[]> {
  const rows = await db.groupMember.findMany({
    where: { userId, group: forumGroupsWhere(a) },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/**
 * Discussions the user may see: separate groups limit non-moderators to their groups
 * (plus "all participants" discussions). `null` means no restriction.
 */
export async function visibleGroupFilter(
  ctx: ModuleCtx,
  a: Forum,
  userId: string,
): Promise<string[] | null> {
  if (a.groupMode !== 'SEPARATE' || (await isModerator(ctx, a))) return null;
  return userGroupIds(ctx.db, a, userId);
}

export async function canSeeDiscussion(
  ctx: ModuleCtx,
  a: Forum,
  d: { groupId: string | null },
  userId: string,
): Promise<boolean> {
  const groups = await visibleGroupFilter(ctx, a, userId);
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

async function loadDiscussion(ctx: ModuleCtx, a: Forum, discussionId: string) {
  const d = await ctx.db.forumDiscussion.findUnique({ where: { id: discussionId } });
  if (!d || d.activityId !== a.id) throw new Error('Discussion not found');
  if (!(await canSeeDiscussion(ctx, a, d, uid(ctx)))) throw new Error('Discussion not found');
  return d;
}

async function storeAttachments(
  ctx: ModuleCtx,
  a: Forum,
  postId: string,
  files: z.output<typeof FileInput>[],
) {
  if (files.length > a.settings.maxAttachments) {
    throw new Error(`At most ${a.settings.maxAttachments} attachments`);
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
  const existing = await ctx.db.forumSubscription.findFirst({
    where: { activityId: a.id, userId, discussionId },
  });
  if (!existing) {
    await ctx.db.forumSubscription.create({
      data: { activityId: a.id, userId, discussionId, subscribed: true },
    });
  }
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
  supports: { groups: true, viewCompletion: true, backup: true },
  privacy: {
    async export(ctx, userId) {
      return ctx.db.forumPost.findMany({
        where: { authorId: userId, deletedAt: null },
        select: {
          id: true,
          createdAt: true,
          contentHtml: true,
          discussion: { select: { title: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
    },
    async erase(ctx, userId) {
      // Keep thread structure for other participants; drop the author's words.
      await ctx.db.forumPost.updateMany({
        where: { authorId: userId },
        data: { contentHtml: '', deletedAt: ctx.now },
      });
      await ctx.db.forumSubscription.deleteMany({ where: { userId } });
      await ctx.db.forumReadState.deleteMany({ where: { userId } });
    },
  },
  backup: { userFileAreas: ['attachment'] },
  settings: {
    schema: ForumSettings as unknown as z.ZodType<ForumSettingsT>,
    defaults: () => ForumSettings.parse({}),
  },
  notifications: { post: { email: 'IMMEDIATE' } },
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
  actions: {
    startDiscussion: defineAction({
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
          throw new Error('Only teachers can start questions in a Q&A forum');
        }
        const html = sanitizeRichText(input.message);
        if (isEmptyRichText(html)) throw new Error('The message is empty');
        let groupId = input.groupId ?? null;
        if (a.groupMode !== 'NONE' && !moderator) {
          const mine = await userGroupIds(ctx.db, a, me);
          if (groupId && !mine.includes(groupId)) throw new Error('Not a member of this group');
          if (!groupId && mine.length) groupId = mine[0]!;
        }
        if (groupId) {
          const g = await ctx.db.group.findFirst({
            where: { id: groupId, ...forumGroupsWhere(a) },
          });
          if (!g) throw new Error('Unknown group');
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
        if (!parent || parent.deletedAt) throw new Error('Post not found');
        const d = await loadDiscussion(ctx, a, parent.discussionId);
        const moderator = await isModerator(ctx, a);
        if (d.locked && !moderator) throw new Error('The discussion is locked');
        if (!postVisible(parent, me, moderator)) throw new Error('Post not found');
        if (a.groupMode !== 'NONE' && d.groupId && !moderator) {
          const mine = await userGroupIds(ctx.db, a, me);
          if (!mine.includes(d.groupId)) throw new Error('Not a member of this group');
        }
        let privateTo: string | null = null;
        if (input.private) {
          if (!a.settings.allowPrivateReplies || !moderator) {
            throw new Error('Private replies are not allowed');
          }
          privateTo = parent.authorId;
        } else if (parent.privateToUserId) {
          // replying inside a private thread stays private between the two people
          privateTo = parent.authorId === me ? parent.privateToUserId : parent.authorId;
        }
        const html = sanitizeRichText(input.message);
        if (isEmptyRichText(html)) throw new Error('The message is empty');
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
      input: z.object({ postId: z.string().uuid(), message: z.string().max(200_000) }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        const post = await ctx.db.forumPost.findUnique({ where: { id: input.postId } });
        if (!post || post.deletedAt) throw new Error('Post not found');
        await loadDiscussion(ctx, a, post.discussionId);
        const moderator = await isModerator(ctx, a);
        const withinWindow =
          ctx.now.getTime() - post.createdAt.getTime() <= a.settings.editMinutes * 60_000;
        if (!moderator && (post.authorId !== me || !withinWindow)) {
          throw new Error('You can no longer edit this post');
        }
        const html = sanitizeRichText(input.message);
        if (isEmptyRichText(html)) throw new Error('The message is empty');
        await ctx.db.forumPost.update({
          where: { id: post.id },
          data: { contentHtml: html, editedAt: ctx.now },
        });
        return { ok: true };
      },
    }),
    deletePost: defineAction({
      input: z.object({ postId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        const post = await ctx.db.forumPost.findUnique({
          where: { id: input.postId },
          include: { _count: { select: { replies: { where: { deletedAt: null } } } } },
        });
        if (!post || post.deletedAt) throw new Error('Post not found');
        const d = await loadDiscussion(ctx, a, post.discussionId);
        const moderator = await isModerator(ctx, a);
        const withinWindow =
          ctx.now.getTime() - post.createdAt.getTime() <= a.settings.editMinutes * 60_000;
        if (!moderator && (post.authorId !== me || !withinWindow || post._count.replies > 0)) {
          throw new Error('You cannot delete this post');
        }
        if (!post.parentId) {
          await ctx.db.forumDiscussion.delete({ where: { id: d.id } });
          await ctx.log('forum.discussion.deleted', { activityId: a.id, discussionId: d.id });
          if (post.authorId) await ctx.completion.recompute(a.id, post.authorId);
          return { discussionDeleted: true };
        }
        await ctx.db.forumPost.update({ where: { id: post.id }, data: { deletedAt: ctx.now } });
        await recount(ctx.db, d.id);
        await ctx.log('forum.post.deleted', { activityId: a.id, postId: post.id });
        if (post.authorId) await ctx.completion.recompute(a.id, post.authorId);
        return { discussionDeleted: false };
      },
    }),
    moderate: defineAction({
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
      input: z.object({ discussionId: z.string().uuid().nullish(), subscribed: z.boolean() }),
      async handler(ctx, ref, input) {
        const a = ref as Forum;
        const me = uid(ctx);
        if (a.settings.subscription === 'disabled' || a.settings.subscription === 'forced') {
          throw new Error('Subscriptions cannot be changed in this forum');
        }
        const discussionId = input.discussionId ?? null;
        if (discussionId) await loadDiscussion(ctx, a, discussionId);
        const existing = await ctx.db.forumSubscription.findFirst({
          where: { activityId: a.id, userId: me, discussionId },
        });
        if (existing) {
          await ctx.db.forumSubscription.update({
            where: { id: existing.id },
            data: { subscribed: input.subscribed },
          });
        } else {
          await ctx.db.forumSubscription.create({
            data: { activityId: a.id, userId: me, discussionId, subscribed: input.subscribed },
          });
        }
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
      input: z.object({ discussionId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const d = await loadDiscussion(ctx, ref as Forum, input.discussionId);
        await markRead(ctx.db, d.id, uid(ctx), ctx.now);
        return { ok: true };
      },
    }),
  },
  lifecycle: {
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
