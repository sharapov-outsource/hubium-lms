import { type Competency, type Db, type Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { requireCourseView } from '../courses/courses.ts';
import { courseLearnerIds } from '../enrol/participants.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { defineOperation } from '../operation.ts';
import { isMentorOf } from '../users/mentors.ts';
import { competencyScale } from './frameworks.ts';
import {
  competencyRuleMet,
  isProficient,
  OUTCOMES,
  type Outcome,
  type PointsConfigT,
} from './model.ts';

// A learner's competencies, as Moodle rates them: every rating, completion or note is
// evidence on the learner's competency, given where it happened (a course, an activity,
// the site). Ratings in a course rate the competency in that course, and also the
// learner's own competency when the course pushes its ratings (the default). A
// proficient competency may meet its parent's rule, which then logs evidence, asks for a
// review or completes the parent. Learners ask for reviews; reviewers rate.

type Tx = Prisma.TransactionClient | Db;

/** Which ratings an evidence touches: the course's (with its context) and/or the learner's own. */
interface Where {
  contextId: string;
  courseId?: string | null;
}

export interface EvidenceInput extends Where {
  userId: string;
  competencyId: string;
  action: 'LOG' | 'COMPLETE' | 'OVERRIDE';
  /** A key under "competencies.evidence." with its values. */
  description: string;
  data?: Record<string, string | number>;
  /** OVERRIDE: the new rating (null removes it). */
  grade?: number | null;
  note?: string | null;
  url?: string | null;
  actorId?: string | null;
}

async function pushesRatings(tx: Tx, courseId: string) {
  const s = await tx.courseCompetencySettings.findUnique({ where: { courseId } });
  return s?.pushRatings ?? true;
}

/**
 * Records evidence and applies it: COMPLETE rates with the scale's default value unless
 * rated already, OVERRIDE sets the rating. A competency that becomes proficient may meet
 * its parent's rule.
 */
export async function addEvidence(tx: Tx, e: EvidenceInput): Promise<void> {
  const competency = await tx.competency.findUnique({ where: { id: e.competencyId } });
  if (!competency) throw new NotFoundError('Competency');
  const scale = await competencyScale(tx, competency);
  if (e.action === 'OVERRIDE' && e.grade !== null && e.grade !== undefined)
    if (!Number.isInteger(e.grade) || e.grade < 1 || e.grade > scale.items.length)
      throw new ValidationError({ grade: [msg('errors.competencies.notOnScale')] });
  const uc = await tx.userCompetency.upsert({
    where: { userId_competencyId: { userId: e.userId, competencyId: e.competencyId } },
    create: { userId: e.userId, competencyId: e.competencyId },
    update: {},
  });
  const next = (current: number | null) =>
    e.action === 'OVERRIDE'
      ? (e.grade ?? null)
      : e.action === 'COMPLETE'
        ? (current ?? scale.config.default)
        : current;

  if (e.courseId) {
    const ucc = await tx.userCompetencyCourse.upsert({
      where: {
        userId_courseId_competencyId: {
          userId: e.userId,
          courseId: e.courseId,
          competencyId: e.competencyId,
        },
      },
      create: { userId: e.userId, courseId: e.courseId, competencyId: e.competencyId },
      update: {},
    });
    const grade = next(ucc.grade);
    if (grade !== ucc.grade)
      await tx.userCompetencyCourse.update({
        where: { id: ucc.id },
        data: { grade, proficiency: grade === null ? null : isProficient(scale.config, grade) },
      });
  }
  const own = !e.courseId || (await pushesRatings(tx, e.courseId));
  const grade = own ? next(uc.grade) : uc.grade;
  const proficient = grade === null ? null : isProficient(scale.config, grade);
  if (grade !== uc.grade)
    await tx.userCompetency.update({
      where: { id: uc.id },
      data: { grade, proficiency: proficient },
    });
  await tx.competencyEvidence.create({
    data: {
      userCompetencyId: uc.id,
      action: e.action,
      contextId: e.contextId,
      description: e.description,
      descriptionData: (e.data ?? undefined) as Prisma.InputJsonValue | undefined,
      grade: e.action === 'LOG' ? null : (next(null) ?? null),
      note: e.note ?? null,
      url: e.url ?? null,
      actorId: e.actorId ?? null,
    },
  });
  // newly proficient: the parent's rule may now be met
  if (proficient && !uc.proficiency && competency.parentId)
    await applyParentRule(tx, competency, e.userId, e);
}

async function applyParentRule(tx: Tx, child: Competency, userId: string, at: Where) {
  const parent = await tx.competency.findUnique({ where: { id: child.parentId! } });
  if (!parent?.ruleType || parent.ruleOutcome === 'NONE') return;
  const children = (
    await tx.competency.findMany({ where: { parentId: parent.id }, select: { id: true } })
  ).map((c) => c.id);
  const proficient = new Set(
    (
      await tx.userCompetency.findMany({
        where: { userId, competencyId: { in: children }, proficiency: true },
        select: { competencyId: true },
      })
    ).map((u) => u.competencyId),
  );
  if (
    !competencyRuleMet(
      parent.ruleType,
      parent.ruleConfig as PointsConfigT | null,
      children,
      proficient,
    )
  )
    return;
  await applyOutcome(tx, parent.ruleOutcome, {
    userId,
    competencyId: parent.id,
    contextId: at.contextId,
    courseId: null,
    description: 'ruleMet',
    data: { competency: child.shortName },
  });
}

/** What a rule, an activity or a course does to a competency when it is met or completed. */
export async function applyOutcome(
  tx: Tx,
  outcome: Outcome,
  e: Omit<EvidenceInput, 'action'>,
): Promise<void> {
  if (outcome === 'NONE') return;
  if (outcome === 'COMPLETE') return addEvidence(tx, { ...e, action: 'COMPLETE' });
  await addEvidence(tx, { ...e, action: 'LOG' });
  // sent for review, unless a review is under way
  if (outcome === 'RECOMMEND')
    await tx.userCompetency.updateMany({
      where: { userId: e.userId, competencyId: e.competencyId, status: 'IDLE' },
      data: { status: 'WAITING_FOR_REVIEW' },
    });
}

// ── completion ───────────────────────────────────────────────────────────────

/** An activity was completed: its competencies' outcomes, in its course. */
export async function onActivityCompleted(tx: Tx, activityId: string, userId: string) {
  const links = await tx.activityCompetency.findMany({
    where: { activityId, ruleOutcome: { not: 'NONE' } },
    include: { activity: { select: { courseId: true, name: true } } },
  });
  for (const l of links)
    await applyOutcome(tx, l.ruleOutcome, {
      userId,
      competencyId: l.competencyId,
      contextId: activityId,
      courseId: l.activity.courseId,
      description: 'activityCompleted',
      data: { name: l.activity.name },
    });
}

/** A course was completed: its competencies' outcomes. */
export async function onCourseCompleted(tx: Tx, courseId: string, userId: string) {
  const links = await tx.courseCompetency.findMany({
    where: { courseId, ruleOutcome: { not: 'NONE' } },
    include: { course: { select: { fullName: true } } },
  });
  for (const l of links)
    await applyOutcome(tx, l.ruleOutcome, {
      userId,
      competencyId: l.competencyId,
      contextId: courseId,
      courseId,
      description: 'courseCompleted',
      data: { name: l.course.fullName },
    });
}

// ── courses and activities ───────────────────────────────────────────────────

const outcome = z.enum(OUTCOMES);

export const addCourseCompetencies = defineOperation({
  name: 'competency.course.add',
  offline: 'replay',
  input: z.object({
    courseId: z.string().uuid(),
    competencyIds: z.array(z.string().uuid()).min(1).max(200),
  }),
  authorize: (ctx, i) => ctx.perm.require('competency:coursemanage', i.courseId),
  async handler(ctx, { courseId, competencyIds }) {
    const found = await ctx.tx.competency.findMany({
      where: { id: { in: competencyIds }, framework: { visible: true } },
      select: { id: true },
    });
    if (found.length !== new Set(competencyIds).size)
      throw new ValidationError({ competencyIds: [msg('errors.competencies.unknownCompetency')] });
    const last = await ctx.tx.courseCompetency.aggregate({
      where: { courseId },
      _max: { sortOrder: true },
    });
    let n = (last._max.sortOrder ?? -1) + 1;
    for (const id of competencyIds)
      await ctx.tx.courseCompetency.upsert({
        where: { courseId_competencyId: { courseId, competencyId: id } },
        create: { courseId, competencyId: id, sortOrder: n++ },
        update: {},
      });
    return { added: competencyIds.length };
  },
});

export const removeCourseCompetency = defineOperation({
  name: 'competency.course.remove',
  offline: 'guarded',
  input: z.object({ courseId: z.string().uuid(), competencyId: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('competency:coursemanage', i.courseId),
  async handler(ctx, { courseId, competencyId }) {
    // the course's activities let go of it too
    await ctx.tx.activityCompetency.deleteMany({ where: { competencyId, activity: { courseId } } });
    await ctx.tx.courseCompetency.deleteMany({ where: { courseId, competencyId } });
    return { competencyId };
  },
});

export const setCourseCompetency = defineOperation({
  name: 'competency.course.set',
  offline: 'guarded',
  input: z.object({
    courseId: z.string().uuid(),
    competencyId: z.string().uuid(),
    ruleOutcome: outcome.optional(),
    move: z.enum(['up', 'down']).optional(),
  }),
  authorize: (ctx, i) => ctx.perm.require('competency:coursemanage', i.courseId),
  async handler(ctx, { courseId, competencyId, ruleOutcome, move }) {
    const link = await ctx.tx.courseCompetency.findUnique({
      where: { courseId_competencyId: { courseId, competencyId } },
    });
    if (!link) throw new NotFoundError('Course competency');
    if (ruleOutcome)
      await ctx.tx.courseCompetency.update({ where: { id: link.id }, data: { ruleOutcome } });
    if (move) {
      const all = await ctx.tx.courseCompetency.findMany({
        where: { courseId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      const i = all.findIndex((x) => x.id === link.id);
      const j = move === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < all.length) {
        [all[i], all[j]] = [all[j]!, all[i]!];
        for (const [k, x] of all.entries())
          await ctx.tx.courseCompetency.update({ where: { id: x.id }, data: { sortOrder: k } });
      }
    }
    return { competencyId };
  },
});

export const setCourseCompetencySettings = defineOperation({
  name: 'competency.course.settings',
  offline: 'guarded',
  input: z.object({ courseId: z.string().uuid(), pushRatings: z.boolean() }),
  authorize: (ctx, i) => ctx.perm.require('competency:coursemanage', i.courseId),
  async handler(ctx, { courseId, pushRatings }) {
    await ctx.tx.courseCompetencySettings.upsert({
      where: { courseId },
      create: { courseId, pushRatings },
      update: { pushRatings },
    });
    return { courseId };
  },
});

/** Links a course competency to an activity of the course, or changes or removes the link. */
export const setActivityCompetency = defineOperation({
  name: 'competency.activity.set',
  offline: 'guarded',
  input: z.object({
    activityId: z.string().uuid(),
    competencyId: z.string().uuid(),
    /** null removes the link. */
    ruleOutcome: outcome.nullable(),
  }),
  async authorize(ctx, i) {
    const a = await ctx.db.activity.findUnique({ where: { id: i.activityId } });
    if (!a) throw new NotFoundError('Activity');
    await ctx.perm.require('competency:coursemanage', a.courseId);
  },
  async handler(ctx, { activityId, competencyId, ruleOutcome }) {
    const a = await ctx.tx.activity.findUniqueOrThrow({ where: { id: activityId } });
    if (ruleOutcome === null) {
      await ctx.tx.activityCompetency.deleteMany({ where: { activityId, competencyId } });
      return { activityId };
    }
    if (
      !(await ctx.tx.courseCompetency.findUnique({
        where: { courseId_competencyId: { courseId: a.courseId, competencyId } },
      }))
    )
      throw new ValidationError({ competencyId: [msg('errors.competencies.addToCourseFirst')] });
    await ctx.tx.activityCompetency.upsert({
      where: { activityId_competencyId: { activityId, competencyId } },
      create: { activityId, competencyId, ruleOutcome },
      update: { ruleOutcome },
    });
    return { activityId };
  },
});

// ── rating ───────────────────────────────────────────────────────────────────

/** A teacher rates a learner on a competency of the course (null removes the rating). */
export const rateInCourse = defineOperation({
  name: 'competency.rate',
  offline: 'guarded',
  input: z.object({
    courseId: z.string().uuid(),
    userId: z.string().uuid(),
    competencyId: z.string().uuid(),
    grade: z.number().int().min(1).nullable(),
    note: z.string().trim().max(2000).default(''),
  }),
  authorize: (ctx, i) => ctx.perm.require('competency:rate', i.courseId),
  async handler(ctx, i) {
    if (
      !(await ctx.tx.courseCompetency.findUnique({
        where: { courseId_competencyId: { courseId: i.courseId, competencyId: i.competencyId } },
      }))
    )
      throw new ValidationError({ competencyId: [msg('errors.competencies.notInCourse')] });
    if (!(await courseLearnerIds(ctx.tx, i.courseId)).includes(i.userId))
      throw new ValidationError({ userId: [msg('errors.certificates.notLearner')] });
    await addEvidence(ctx.tx, {
      userId: i.userId,
      competencyId: i.competencyId,
      contextId: i.courseId,
      courseId: i.courseId,
      action: 'OVERRIDE',
      grade: i.grade,
      description: 'ratedInCourse',
      note: i.note || null,
      actorId: ctx.perm.userId,
    });
    await logEvent(ctx.tx, {
      name: 'competency.rated',
      actorId: ctx.perm.userId,
      courseId: i.courseId,
      relatedUserId: i.userId,
      data: { competencyId: i.competencyId, grade: i.grade },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { grade: i.grade };
  },
});

/** A reviewer rates a person's competency itself (null removes the rating). */
export const rateUserCompetency = defineOperation({
  name: 'competency.rateuser',
  offline: 'guarded',
  input: z.object({
    userId: z.string().uuid(),
    competencyId: z.string().uuid(),
    grade: z.number().int().min(1).nullable(),
    note: z.string().trim().max(2000).default(''),
  }),
  authorize: (ctx) => ctx.perm.require('competency:review'),
  async handler(ctx, i) {
    if (i.userId === ctx.perm.userId && !ctx.perm.isSiteAdmin)
      throw new ForbiddenError(msg('errors.competencies.noSelfRating'));
    await addEvidence(ctx.tx, {
      userId: i.userId,
      competencyId: i.competencyId,
      contextId: SYSTEM_CONTEXT_ID,
      action: 'OVERRIDE',
      grade: i.grade,
      description: 'rated',
      note: i.note || null,
      actorId: ctx.perm.userId,
    });
    await logEvent(ctx.tx, {
      name: 'competency.rated',
      actorId: ctx.perm.userId,
      relatedUserId: i.userId,
      data: { competencyId: i.competencyId, grade: i.grade },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { grade: i.grade };
  },
});

/** Evidence a reviewer notes by hand (a link, an observation). */
export const addManualEvidence = defineOperation({
  name: 'competency.evidence.add',
  offline: 'replay',
  input: z.object({
    userId: z.string().uuid(),
    competencyId: z.string().uuid(),
    note: z.string().trim().min(1).max(2000),
    url: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2000)]).default(''),
  }),
  authorize: (ctx) => ctx.perm.require('competency:review'),
  async handler(ctx, i) {
    await addEvidence(ctx.tx, {
      userId: i.userId,
      competencyId: i.competencyId,
      contextId: SYSTEM_CONTEXT_ID,
      action: 'LOG',
      description: 'manual',
      note: i.note,
      url: i.url || null,
      actorId: ctx.perm.userId,
    });
    return null;
  },
});

// ── reviews ──────────────────────────────────────────────────────────────────

/** A review: asked for by the learner (or withdrawn), started and finished by a reviewer. */
export const reviewUserCompetency = defineOperation({
  name: 'competency.review',
  offline: 'guarded',
  input: z.object({
    userId: z.string().uuid(),
    competencyId: z.string().uuid(),
    step: z.enum(['request', 'cancel', 'start', 'stop']),
  }),
  async authorize(ctx, i) {
    if (i.step === 'request' || i.step === 'cancel') {
      if (i.userId !== ctx.perm.userId) await ctx.perm.require('competency:review');
      else await ctx.perm.require('competency:requestreview');
    } else await ctx.perm.require('competency:review');
  },
  async handler(ctx, { userId, competencyId, step }) {
    const uc = await ctx.tx.userCompetency.upsert({
      where: { userId_competencyId: { userId, competencyId } },
      create: { userId, competencyId },
      update: {},
    });
    const from: Record<typeof step, string[]> = {
      request: ['IDLE'],
      cancel: ['WAITING_FOR_REVIEW'],
      start: ['IDLE', 'WAITING_FOR_REVIEW'],
      stop: ['IN_REVIEW'],
    };
    if (!from[step].includes(uc.status))
      throw new ConflictError(msg('errors.competencies.wrongReviewStep'));
    const status =
      step === 'request' ? 'WAITING_FOR_REVIEW' : step === 'start' ? 'IN_REVIEW' : 'IDLE';
    await ctx.tx.userCompetency.update({
      where: { id: uc.id },
      data: { status, reviewerId: step === 'start' ? ctx.perm.userId : uc.reviewerId },
    });
    return { status };
  },
});

// ── who sees what ────────────────────────────────────────────────────────────

/** Whether the viewer may see a person's competencies and plans. */
export async function canViewUserCompetencies(ctx: RequestContext, userId: string) {
  if (ctx.perm.userId === userId) return true;
  if (await ctx.perm.can('competency:planview')) return true;
  return !!ctx.perm.userId && isMentorOf(ctx.db as Db, ctx.perm.userId, userId);
}

// ── reading ──────────────────────────────────────────────────────────────────

/** A course's competencies, with the activities linked to each and the viewer's ratings. */
export async function courseCompetencies(ctx: RequestContext, courseId: string) {
  await requireCourseView(ctx, courseId);
  const [manage, rate, viewRatings, settings] = await Promise.all([
    ctx.perm.can('competency:coursemanage', courseId),
    ctx.perm.can('competency:rate', courseId),
    ctx.perm.can('competency:viewratings', courseId),
    ctx.db.courseCompetencySettings.findUnique({ where: { courseId } }),
  ]);
  const links = await ctx.db.courseCompetency.findMany({
    where: { courseId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: {
      competency: { include: { framework: { select: { id: true, shortName: true } } } },
    },
  });
  const ids = links.map((l) => l.competencyId);
  const [activities, mine] = await Promise.all([
    ctx.db.activityCompetency.findMany({
      where: {
        competencyId: { in: ids },
        // learners see the activities they can see
        activity: { courseId, deletedAt: null, ...(manage ? {} : { visibility: 'SHOWN' }) },
      },
      include: { activity: { select: { id: true, name: true, moduleKey: true } } },
    }),
    ctx.perm.userId
      ? ctx.db.userCompetencyCourse.findMany({
          where: { courseId, userId: ctx.perm.userId, competencyId: { in: ids } },
        })
      : [],
  ]);
  const scales = new Map(
    await Promise.all(
      links.map(
        async (l) => [l.competencyId, await competencyScale(ctx.db, l.competency)] as const,
      ),
    ),
  );
  return {
    manage,
    rate,
    viewRatings,
    pushRatings: settings?.pushRatings ?? true,
    competencies: links.map((l) => ({
      ...l,
      scale: scales.get(l.competencyId)!,
      activities: activities.filter((a) => a.competencyId === l.competencyId),
      mine: mine.find((m) => m.competencyId === l.competencyId) ?? null,
    })),
  };
}

/** Learners × the course's competencies, with their ratings in the course. */
export async function courseBreakdown(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('competency:viewratings', courseId);
  const learners = await courseLearnerIds(ctx.db, courseId);
  const [users, links, ratings] = await Promise.all([
    ctx.db.user.findMany({
      where: { id: { in: learners } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    ctx.db.courseCompetency.findMany({
      where: { courseId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { competency: true },
    }),
    ctx.db.userCompetencyCourse.findMany({ where: { courseId, userId: { in: learners } } }),
  ]);
  const scales = new Map(
    await Promise.all(
      links.map(
        async (l) => [l.competencyId, await competencyScale(ctx.db, l.competency)] as const,
      ),
    ),
  );
  return {
    users,
    competencies: links.map((l) => ({ ...l.competency, scale: scales.get(l.competencyId)! })),
    rating: (userId: string, competencyId: string) =>
      ratings.find((r) => r.userId === userId && r.competencyId === competencyId) ?? null,
  };
}

/** One learner's competencies in a course: their ratings and the evidence given there. */
export async function learnerInCourse(ctx: RequestContext, courseId: string, userId: string) {
  if (userId !== ctx.perm.userId) await ctx.perm.require('competency:viewratings', courseId);
  // someone enrolled in the course (now or before): not anyone on the site
  const user = await ctx.db.user.findFirst({
    where: { id: userId, enrolments: { some: { courseId } } },
    select: { id: true, name: true },
  });
  if (!user) throw new NotFoundError('User');
  const links = await ctx.db.courseCompetency.findMany({
    where: { courseId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { competency: true },
  });
  const ids = links.map((l) => l.competencyId);
  const activityIds = (
    await ctx.db.activity.findMany({ where: { courseId }, select: { id: true } })
  ).map((a) => a.id);
  const [ratings, own, evidence] = await Promise.all([
    ctx.db.userCompetencyCourse.findMany({
      where: { courseId, userId, competencyId: { in: ids } },
    }),
    ctx.db.userCompetency.findMany({ where: { userId, competencyId: { in: ids } } }),
    ctx.db.competencyEvidence.findMany({
      where: {
        userCompetency: { userId, competencyId: { in: ids } },
        contextId: { in: [courseId, ...activityIds] },
      },
      orderBy: { createdAt: 'desc' },
      include: { userCompetency: { select: { competencyId: true } } },
    }),
  ]);
  const actors = await ctx.db.user.findMany({
    where: { id: { in: evidence.flatMap((e) => (e.actorId ? [e.actorId] : [])) } },
    select: { id: true, name: true },
  });
  const scales = new Map(
    await Promise.all(
      links.map(
        async (l) => [l.competencyId, await competencyScale(ctx.db, l.competency)] as const,
      ),
    ),
  );
  return {
    user,
    competencies: links.map((l) => ({
      ...l.competency,
      scale: scales.get(l.competencyId)!,
      rating: ratings.find((r) => r.competencyId === l.competencyId) ?? null,
      own: own.find((r) => r.competencyId === l.competencyId) ?? null,
      evidence: evidence
        .filter((e) => e.userCompetency.competencyId === l.competencyId)
        .map((e) => ({ ...e, actor: actors.find((a) => a.id === e.actorId)?.name ?? null })),
    })),
  };
}

/** A person's competency: its rating, review, evidence and comments, and the plans it is in. */
export async function userCompetencyDetail(
  ctx: RequestContext,
  userId: string,
  competencyId: string,
) {
  if (!(await canViewUserCompetencies(ctx, userId))) throw new ForbiddenError();
  const [user, competency, uc] = await Promise.all([
    ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, name: true } }),
    ctx.db.competency.findUnique({
      where: { id: competencyId },
      include: { framework: { select: { id: true, shortName: true, taxonomies: true } } },
    }),
    ctx.db.userCompetency.findUnique({
      where: { userId_competencyId: { userId, competencyId } },
      include: {
        evidence: { orderBy: { createdAt: 'desc' } },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, name: true } } },
        },
      },
    }),
  ]);
  if (!user || !competency) throw new NotFoundError('Competency');
  const [plans, userEvidence, review, requestReview] = await Promise.all([
    ctx.db.learningPlan.findMany({
      where: {
        userId,
        OR: [
          { competencies: { some: { competencyId } } },
          { template: { competencies: { some: { competencyId } } } },
        ],
      },
      select: { id: true, name: true, status: true },
    }),
    ctx.db.userEvidence.findMany({
      where: { userId, competencies: { some: { competencyId } } },
      select: { id: true, name: true, url: true },
    }),
    ctx.perm.can('competency:review'),
    ctx.perm.can('competency:requestreview'),
  ]);
  const actorIds = (uc?.evidence ?? []).flatMap((e) => (e.actorId ? [e.actorId] : []));
  const actors = await ctx.db.user.findMany({
    where: { id: { in: [...actorIds, ...(uc?.reviewerId ? [uc.reviewerId] : [])] } },
    select: { id: true, name: true },
  });
  return {
    user,
    competency,
    scale: await competencyScale(ctx.db, competency),
    rating: uc,
    reviewer: actors.find((a) => a.id === uc?.reviewerId)?.name ?? null,
    evidence: (uc?.evidence ?? []).map((e) => ({
      ...e,
      actor: actors.find((a) => a.id === e.actorId)?.name ?? null,
    })),
    comments: uc?.comments ?? [],
    plans,
    userEvidence,
    can: {
      review: review && userId !== ctx.perm.userId,
      requestReview: requestReview && userId === ctx.perm.userId,
    },
  };
}
