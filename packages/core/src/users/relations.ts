import type { Db, UserRelationKind } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { listMyCourses } from '../courses/courses.ts';
import { collectTodo } from '../dashboard/todo.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { learnerCourseTotal } from '../grades/gradebook.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings } from '../settings/settings.ts';
import { isMentorOf, learnerPermissions } from './mentors.ts';
import { parseCsv } from './users.ts';

export { isMentorOf };

// Mentors and parents (Administration → Settings → General turns them on). An administrator
// links a mentor to a mentee; the mentor then sees the mentee's courses, progress, grades,
// deadlines and last visit. They never act for the mentee and never see their messages.

export type UserDataAspect = 'overview' | 'grades';

/**
 * May the caller see another user's learning data? The user themselves and site
 * administrators may; user managers (`user:update`) see the overview, holders of
 * `grade:viewall` the grades in their course; so may the user's mentors (see isMentorOf).
 */
export async function canViewUserData(
  ctx: RequestContext,
  targetId: string,
  aspect: UserDataAspect,
  courseId?: string,
): Promise<boolean> {
  const me = ctx.perm.userId;
  if (!me) return false;
  if (me === targetId || ctx.perm.isSiteAdmin) return true;
  if (aspect === 'grades' && courseId && (await ctx.perm.can('grade:viewall', courseId)))
    return true;
  // user managers see who learns what, not grades (those follow the course's permissions)
  if (aspect === 'overview' && (await ctx.perm.can('user:update'))) return true;
  return isMentorOf(ctx.db, me, targetId);
}

export async function requireViewUserData(
  ctx: RequestContext,
  targetId: string,
  aspect: UserDataAspect,
  courseId?: string,
): Promise<void> {
  if (!(await canViewUserData(ctx, targetId, aspect, courseId))) throw new ForbiddenError();
}

/**
 * A context that acts as `userId` for reading only: the permissions of that user, so module
 * hooks show a mentor what the mentee would see. Never used for writes.
 */
async function readOnlyContextFor(ctx: RequestContext, userId: string): Promise<RequestContext> {
  return {
    db: ctx.db,
    actor: { kind: 'user', userId, isSiteAdmin: false },
    perm: await learnerPermissions(ctx.db, userId),
    now: ctx.now,
    locale: ctx.locale,
    origin: ctx.origin,
  };
}

const Kind = z.enum(['PARENT', 'MENTOR']);

async function activeUser(db: Db, id: string, field: string) {
  const u = await db.user.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
  if (!u || u.deletedAt) throw new ValidationError({ [field]: ['Unknown user'] });
  return u;
}

export const addUserRelation = defineOperation({
  name: 'user.relation.add',
  input: z.object({
    mentorId: z.string().uuid(),
    menteeId: z.string().uuid(),
    kind: Kind.default('MENTOR'),
  }),
  authorize: (ctx) => ctx.perm.require('user:update'),
  async handler(ctx, { mentorId, menteeId, kind }) {
    if (mentorId === menteeId)
      throw new ValidationError({ menteeId: ['A user cannot be their own mentor'] });
    await activeUser(ctx.db, mentorId, 'mentorId');
    await activeUser(ctx.db, menteeId, 'menteeId');
    const r = await ctx.tx.userRelation.upsert({
      where: { mentorId_menteeId: { mentorId, menteeId } },
      create: { mentorId, menteeId, kind },
      update: { kind },
    });
    await logEvent(ctx.tx, {
      name: 'user.relation.added',
      actorId: ctx.perm.userId,
      relatedUserId: menteeId,
      data: { mentorId, kind },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { id: r.id };
  },
});

export const removeUserRelation = defineOperation({
  name: 'user.relation.remove',
  input: z.object({ mentorId: z.string().uuid(), menteeId: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('user:update'),
  async handler(ctx, { mentorId, menteeId }) {
    const { count } = await ctx.tx.userRelation.deleteMany({ where: { mentorId, menteeId } });
    if (count)
      await logEvent(ctx.tx, {
        name: 'user.relation.removed',
        actorId: ctx.perm.userId,
        relatedUserId: menteeId,
        data: { mentorId },
        origin: ctx.origin,
        ip: ctx.ip,
      });
    return { removed: count };
  },
});

export interface RelationUploadResult {
  added: number;
  removed: number;
  errors: { line: number; message: string }[];
}

/**
 * Links (or unlinks) mentors and mentees from CSV: columns `mentor`, `mentee` (email or
 * username), optional `kind` (parent | mentor, default mentor) and `action` (add | remove).
 */
export const bulkUploadUserRelations = defineOperation({
  name: 'user.relation.bulkUpload',
  input: z.object({ csv: z.string().min(1).max(5_000_000) }),
  authorize: (ctx) => ctx.perm.require('user:update'),
  mutation: false,
  async handler(ctx, { csv }): Promise<RelationUploadResult> {
    const rows = parseCsv(csv);
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    if (col('mentor') < 0 || col('mentee') < 0)
      throw new ValidationError({ csv: ['Header must include: mentor, mentee'] });
    const find = (login: string) =>
      ctx.db.user.findFirst({
        where: {
          deletedAt: null,
          OR: [{ email: login }, { username: login }],
        },
        select: { id: true },
      });
    const result: RelationUploadResult = { added: 0, removed: 0, errors: [] };
    for (const [i, r] of rows.entries()) {
      const get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? '').trim() : '');
      const line = i + 2;
      try {
        const [mentor, mentee] = await Promise.all([find(get('mentor')), find(get('mentee'))]);
        if (!mentor) throw new Error(`Unknown mentor "${get('mentor')}"`);
        if (!mentee) throw new Error(`Unknown mentee "${get('mentee')}"`);
        const action = get('action').toLowerCase() || 'add';
        if (action === 'remove') {
          const { removed } = await removeUserRelation.run(ctx, {
            mentorId: mentor.id,
            menteeId: mentee.id,
          });
          result.removed += removed;
        } else if (action === 'add') {
          const kind = get('kind').toUpperCase() || 'MENTOR';
          if (!Kind.safeParse(kind).success) throw new Error(`Unknown kind "${get('kind')}"`);
          await addUserRelation.run(ctx, {
            mentorId: mentor.id,
            menteeId: mentee.id,
            kind,
          });
          result.added++;
        } else throw new Error(`Unknown action "${get('action')}"`);
      } catch (e) {
        const message =
          e instanceof ValidationError
            ? Object.values(e.fieldErrors ?? {})
                .flat()
                .join('; ')
            : e instanceof Error
              ? e.message
              : String(e);
        result.errors.push({ line, message });
      }
    }
    return result;
  },
});

export interface RelatedUser {
  id: string;
  name: string;
  email: string | null;
  kind: UserRelationKind;
}

/** Both sides of a user's relations, for the admin user card. */
export async function userRelations(ctx: RequestContext, userId: string) {
  await ctx.perm.require('user:update');
  const rows = await ctx.db.userRelation.findMany({
    where: { OR: [{ mentorId: userId }, { menteeId: userId }] },
    include: {
      mentor: { select: { id: true, name: true, email: true, emailPlaceholder: true } },
      mentee: { select: { id: true, name: true, email: true, emailPlaceholder: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const person = (
    u: { id: string; name: string; email: string; emailPlaceholder: boolean },
    kind: UserRelationKind,
  ): RelatedUser => ({ id: u.id, name: u.name, email: u.emailPlaceholder ? null : u.email, kind });
  return {
    mentors: rows.filter((r) => r.menteeId === userId).map((r) => person(r.mentor, r.kind)),
    mentees: rows.filter((r) => r.mentorId === userId).map((r) => person(r.mentee, r.kind)),
  };
}

/** Who can follow this user's learning (their profile's privacy page shows it). */
export async function listMentorsOf(db: Db, userId: string) {
  if (!(await getAllSettings(db))['mentors.enabled']) return [];
  const rows = await db.userRelation.findMany({
    where: { menteeId: userId, mentor: { deletedAt: null } },
    include: { mentor: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ id: r.mentor.id, name: r.mentor.name, kind: r.kind }));
}

/** The last visit, or the last sign-in for accounts not seen since visits were recorded. */
const lastVisit = (u: { lastAccessAt: Date | null; lastLoginAt: Date | null }) =>
  u.lastAccessAt ?? u.lastLoginAt;

/** The caller's mentees with their last visit; empty while the feature is off. */
export async function listMentees(ctx: RequestContext) {
  const me = ctx.perm.userId;
  if (!me || !(await getAllSettings(ctx.db))['mentors.enabled']) return [];
  const rows = await ctx.db.userRelation.findMany({
    where: { mentorId: me, mentee: { deletedAt: null, status: 'ACTIVE' } },
    include: {
      mentee: { select: { id: true, name: true, lastAccessAt: true, lastLoginAt: true } },
    },
  });
  return rows
    .map((r) => ({
      id: r.mentee.id,
      name: r.mentee.name,
      kind: r.kind,
      lastAccessAt: lastVisit(r.mentee),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Does the caller have anyone to follow? (The navigation shows "My mentees" then.) */
export async function hasMentees(db: Db, userId: string): Promise<boolean> {
  if (!(await getAllSettings(db))['mentors.enabled']) return false;
  return (
    (await db.userRelation.count({
      where: { mentorId: userId, mentee: { deletedAt: null, status: 'ACTIVE' } },
    })) > 0
  );
}

/**
 * What a mentor (or the user) sees of a learner: the courses they study with progress and
 * the course total (when the learner may see grades and the total is not hidden), the
 * submissions and quizzes due, and their last visit.
 */
export async function menteeOverview(ctx: RequestContext, menteeId: string) {
  await requireViewUserData(ctx, menteeId, 'overview');
  const user = await ctx.db.user.findUnique({
    where: { id: menteeId },
    select: { id: true, name: true, lastAccessAt: true, lastLoginAt: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw new NotFoundError('User');
  const as = await readOnlyContextFor(ctx, menteeId);
  const courses = (await listMyCourses(ctx.db, menteeId)).filter((c) => c.role === 'student');
  const now = new Date();
  const totals = await ctx.db.gradeItem.findMany({
    where: { courseId: { in: courses.map((c) => c.id) }, kind: 'COURSE' },
    include: { grades: { where: { userId: menteeId } } },
  });
  const rows = await Promise.all(
    courses.map(async (c) => {
      const item = totals.find((t) => t.courseId === c.id);
      const g = item?.grades[0];
      const visible =
        item &&
        !item.hidden &&
        (!item.hiddenUntil || item.hiddenUntil <= now) &&
        !g?.hidden &&
        (await as.perm.can('grade:view', c.id));
      return {
        id: c.id,
        fullName: c.fullName,
        progress: c.progress,
        lastAccessAt: c.lastAccessAt,
        grade: await (async () => {
          if (!visible) return null;
          // without what is hidden from the learner, as they see it themselves
          const value = await learnerCourseTotal(ctx.db, c.id, menteeId);
          return value === null ? null : { value: Number(value), max: Number(item.gradeMax) };
        })(),
      };
    }),
  );
  const todo = await collectTodo(as, menteeId, { kinds: ['submit', 'attempt'], limit: 20 });
  return {
    user: { id: user.id, name: user.name, lastAccessAt: lastVisit(user) },
    courses: rows,
    todo,
  };
}

/** For the mentor's course page: is this learner enrolled to study the course? */
export async function menteeStudies(db: Db, menteeId: string, courseId: string) {
  return (await listMyCourses(db, menteeId)).some((c) => c.id === courseId && c.role === 'student');
}
