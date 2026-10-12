import type { CompletionState, Db, Prisma } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { buildModuleCtx, provideModuleServices, toActivityRef } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { defineOperation } from '../operation.ts';

type Tx = Prisma.TransactionClient | Db;

/** Recomputes the course progress percentage for one user. */
export async function recomputeCourseProgress(
  tx: Tx,
  courseId: string,
  userId: string,
): Promise<number> {
  const course = await tx.course.findUnique({
    where: { id: courseId },
    select: { enableCompletion: true },
  });
  if (!course?.enableCompletion) return 0;
  const tracked = await tx.activity.findMany({
    where: { courseId, deletedAt: null, visibility: 'SHOWN', completionMode: { not: 'NONE' } },
    select: { id: true },
  });
  const done = tracked.length
    ? await tx.activityCompletion.count({
        where: {
          userId,
          activityId: { in: tracked.map((t) => t.id) },
          state: { not: 'INCOMPLETE' },
        },
      })
    : 0;
  const percent = tracked.length ? Math.round((done / tracked.length) * 100) : 0;
  const now = new Date();
  const existing = await tx.courseCompletion.findUnique({
    where: { courseId_userId: { courseId, userId } },
  });
  const completedAt = percent === 100 && tracked.length ? (existing?.completedAt ?? now) : null;
  await tx.courseCompletion.upsert({
    where: { courseId_userId: { courseId, userId } },
    create: { courseId, userId, progressPercent: percent, startedAt: now, completedAt },
    update: { progressPercent: percent, completedAt },
  });
  return percent;
}

async function writeState(
  tx: Tx,
  activityId: string,
  userId: string,
  state: CompletionState,
  extra: { overriddenById?: string | null } = {},
) {
  await tx.activityCompletion.upsert({
    where: { activityId_userId: { activityId, userId } },
    create: {
      activityId,
      userId,
      state,
      completedAt: state === 'INCOMPLETE' ? null : new Date(),
      ...extra,
    },
    update: { state, completedAt: state === 'INCOMPLETE' ? null : new Date(), ...extra },
  });
}

/** Evaluates automatic completion rules (view + module rules) and stores the result. */
export async function recomputeActivityCompletion(
  ctx: RequestContext,
  tx: Prisma.TransactionClient,
  activityId: string,
  userId: string,
) {
  const a = await tx.activity.findUnique({ where: { id: activityId } });
  if (a?.completionMode !== 'AUTO') return;
  const row = await tx.activityCompletion.findUnique({
    where: { activityId_userId: { activityId, userId } },
  });
  if (row?.overriddenById) return; // a teacher override wins until cleared
  const rules = (a.completionRules ?? {}) as { view?: boolean; module?: Record<string, unknown> };
  let state: CompletionState = 'COMPLETE';
  if (rules.view && !row?.viewedAt) state = 'INCOMPLETE';
  const m = getModule(a.moduleKey);
  if (state !== 'INCOMPLETE' && rules.module && m?.completion) {
    const parsed = m.completion.schema.safeParse(rules.module);
    if (parsed.success) {
      const r = await m.completion.evaluate(
        buildModuleCtx(ctx, tx),
        toActivityRef(a),
        userId,
        parsed.data,
      );
      state =
        r === 'pass'
          ? 'COMPLETE_PASS'
          : r === 'fail'
            ? 'COMPLETE_FAIL'
            : r === 'complete'
              ? 'COMPLETE'
              : 'INCOMPLETE';
    }
  }
  if ((row?.state ?? 'INCOMPLETE') !== state) {
    await writeState(tx, activityId, userId, state);
    await recomputeCourseProgress(tx, a.courseId, userId);
  }
}

export async function markActivityViewed(
  ctx: RequestContext,
  tx: Prisma.TransactionClient,
  activityId: string,
  userId: string,
) {
  const a = await tx.activity.findUnique({
    where: { id: activityId },
    select: { completionMode: true, courseId: true },
  });
  if (!a) return;
  await tx.activityCompletion.upsert({
    where: { activityId_userId: { activityId, userId } },
    create: { activityId, userId, viewedAt: new Date() },
    update: { viewedAt: new Date() },
  });
  if (a.completionMode === 'AUTO') await recomputeActivityCompletion(ctx, tx, activityId, userId);
}

provideModuleServices({
  markViewed: (ctx, tx) => (activityId, userId) => markActivityViewed(ctx, tx, activityId, userId),
  recomputeCompletion: (ctx, tx) => (activityId, userId) =>
    recomputeActivityCompletion(ctx, tx, activityId, userId),
});

/** Learner ticks "mark as done" on a manually completed activity. */
export const toggleManualCompletion = defineOperation({
  name: 'completion.manual',
  input: z.object({ activityId: z.string().uuid(), done: z.boolean() }),
  async handler(ctx, { activityId, done }) {
    const userId = ctx.perm.userId;
    if (!userId) throw new ForbiddenError();
    const a = await ctx.tx.activity.findUnique({ where: { id: activityId } });
    if (!a || a.deletedAt) throw new NotFoundError('Activity');
    if (a.completionMode !== 'MANUAL')
      throw new ValidationError({ activityId: ['This activity is completed automatically'] });
    const enrolled = await ctx.tx.enrolment.findFirst({
      where: { courseId: a.courseId, userId, status: 'ACTIVE' },
    });
    if (!enrolled) throw new ForbiddenError('Only enrolled users track completion');
    await writeState(ctx.tx, activityId, userId, done ? 'COMPLETE' : 'INCOMPLETE');
    const percent = await recomputeCourseProgress(ctx.tx, a.courseId, userId);
    await logEvent(ctx.tx, {
      name: 'completion.manual',
      actorId: userId,
      courseId: a.courseId,
      contextId: a.id,
      data: { done },
      origin: ctx.origin,
    });
    return { percent };
  },
});

/** Teacher overrides a learner's completion state (or clears the override). */
export const overrideCompletion = defineOperation({
  name: 'completion.override',
  input: z.object({
    activityId: z.string().uuid(),
    userId: z.string().uuid(),
    state: z.enum(['INCOMPLETE', 'COMPLETE', 'CLEAR']),
  }),
  async authorize(ctx, i) {
    const a = await ctx.db.activity.findUnique({
      where: { id: i.activityId },
      select: { courseId: true },
    });
    if (!a) throw new NotFoundError('Activity');
    await ctx.perm.require('completion:override', a.courseId);
  },
  async handler(ctx, { activityId, userId, state }) {
    const a = await ctx.tx.activity.findUniqueOrThrow({ where: { id: activityId } });
    if (state === 'CLEAR') {
      await ctx.tx.activityCompletion.updateMany({
        where: { activityId, userId },
        data: { overriddenById: null },
      });
      await recomputeActivityCompletion(ctx, ctx.tx, activityId, userId);
    } else {
      await writeState(ctx.tx, activityId, userId, state, { overriddenById: ctx.perm.userId });
    }
    await recomputeCourseProgress(ctx.tx, a.courseId, userId);
    return { ok: true };
  },
});

/** Completion matrix: learners × tracked activities. */
export async function completionReport(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('completion:viewreports', courseId);
  const studentRole = await ctx.db.role.findUnique({ where: { shortName: 'student' } });
  const [activities, learners] = await Promise.all([
    ctx.db.activity.findMany({
      where: { courseId, deletedAt: null, completionMode: { not: 'NONE' } },
      orderBy: [{ section: { rank: 'asc' } }, { rank: 'asc' }],
      select: { id: true, name: true, moduleKey: true, completionMode: true },
    }),
    ctx.db.user.findMany({
      where: {
        deletedAt: null,
        enrolments: { some: { courseId, status: 'ACTIVE' } },
        roleAssignments: { some: { contextId: courseId, roleId: studentRole?.id } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);
  const [rows, courseRows] = await Promise.all([
    ctx.db.activityCompletion.findMany({
      where: {
        activityId: { in: activities.map((a) => a.id) },
        userId: { in: learners.map((l) => l.id) },
      },
    }),
    ctx.db.courseCompletion.findMany({
      where: { courseId, userId: { in: learners.map((l) => l.id) } },
    }),
  ]);
  const cell = new Map(rows.map((r) => [`${r.userId}:${r.activityId}`, r]));
  return {
    activities,
    learners: learners.map((l) => ({
      ...l,
      progress: courseRows.find((c) => c.userId === l.id)?.progressPercent ?? 0,
      completedAt: courseRows.find((c) => c.userId === l.id)?.completedAt ?? null,
      cells: activities.map((a) => cell.get(`${l.id}:${a.id}`)?.state ?? 'INCOMPLETE'),
    })),
  };
}
