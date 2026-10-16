import { randomBytes } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { type Badge, type BadgeAward, type Db, type Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { createTranslator } from '@hubium/i18n/packs';
import { log } from '@hubium/log';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import { roleName } from '../access/roles.ts';
import type { RequestContext } from '../context.ts';
import { requireCourseView } from '../courses/courses.ts';
import { courseLearnerIds } from '../enrol/participants.ts';
import { getEnv } from '../env.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { deleteFiles, storeFile } from '../files/files.ts';
import { getStorage } from '../files/storage.ts';
import { courseGradePercent } from '../grades/course-grade.ts';
import { enqueue } from '../jobs/jobs.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings, setSettings, siteLocale } from '../settings/settings.ts';
import {
  type BadgeCriteriaT,
  type BadgeFacts,
  type BadgeRuleT,
  checkCriteria,
  criteriaMet,
} from './criteria.ts';
import {
  assertionJson,
  badgeClassJson,
  bakePng,
  bakeSvg,
  isPng,
  isSvg,
  issuerJson,
  revokedJson,
} from './openbadges.ts';

const logger = log('badges');

// Badges, as Moodle's: site badges and course badges with criteria, awarded when the
// criteria are met (checked as completion changes, when a badge is activated, and by the
// hourly review for grades and cohorts) or by hand by people in the badge's roles, and
// revoked with a reason. Each award is an Open Badges 2.0 assertion with hosted
// verification: its JSON, the badge class and the issuer are public, and the badge image
// downloads baked with the assertion.

type Tx = Prisma.TransactionClient | Db;

export const BADGE_IMAGE_MAX_BYTES = 1024 * 1024;
export const BADGES_REVIEW_JOB = 'badges.review';

// ── who manages, who earns ───────────────────────────────────────────────────

async function requireManage(ctx: RequestContext, courseId: string | null) {
  if (courseId) await ctx.perm.require('badge:manage', courseId);
  else await ctx.perm.require('badge:managesite');
}

async function requireAward(ctx: RequestContext, courseId: string | null) {
  if (courseId) await ctx.perm.require('badge:award', courseId);
  else await ctx.perm.require('badge:managesite');
}

/** Refuses unless the caller may award the badge by hand. */
export async function requireBadgeAward(ctx: RequestContext, badgeId: string) {
  await requireAward(ctx, (await loadBadge(ctx.db, badgeId)).courseId);
}

async function loadBadge(db: Tx, id: string) {
  const b = await db.badge.findUnique({ where: { id } });
  if (!b) throw new NotFoundError('Badge');
  return b;
}

async function mayEarn(
  tx: Tx,
  badge: Badge,
  userId: string,
  learners?: Set<string>,
): Promise<boolean> {
  if (badge.courseId)
    return (learners ?? new Set(await courseLearnerIds(tx, badge.courseId))).has(userId);
  const u = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
  return u?.status === 'ACTIVE';
}

// ── saving ───────────────────────────────────────────────────────────────────

/** Every id a rule names must exist (and be the badge's course's, for activities). */
async function checkReferences(tx: Tx, c: BadgeCriteriaT, courseId: string | null) {
  const bad = (field: string) => {
    throw new ValidationError({ criteria: [msg('errors.badges.unknown', { name: field })] });
  };
  for (const r of c.rules) {
    if (r.kind === 'activities') {
      const n = await tx.activity.count({
        where: { id: { in: r.activityIds }, courseId: courseId ?? undefined, deletedAt: null },
      });
      if (n !== new Set(r.activityIds).size) bad('activity');
    } else if (r.kind === 'courses') {
      const n = await tx.course.count({ where: { id: { in: r.courseIds }, deletedAt: null } });
      if (n !== new Set(r.courseIds).size) bad('course');
    } else if (r.kind === 'cohort') {
      const n = await tx.cohort.count({ where: { id: { in: r.cohortIds } } });
      if (n !== new Set(r.cohortIds).size) bad('cohort');
    } else if (r.kind === 'manual') {
      const n = await tx.role.count({ where: { id: { in: r.roleIds } } });
      if (n !== new Set(r.roleIds).size) bad('role');
    }
  }
}

export const BadgeInput = z.object({
  id: z.string().uuid().optional(),
  courseId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(5000).default(''),
  criteria: z.unknown(),
  expiry: z.enum(['never', 'days', 'date']).default('never'),
  expiresAfterDays: z.coerce.number().int().min(1).max(36_500).optional(),
  expiresAt: z.coerce.date().optional(),
});

export const saveBadge = defineOperation({
  name: 'badge.save',
  input: BadgeInput,
  async authorize(ctx, i) {
    const courseId = i.id ? (await loadBadge(ctx.db, i.id)).courseId : (i.courseId ?? null);
    await requireManage(ctx, courseId);
  },
  async handler(ctx, input) {
    const old = input.id ? await loadBadge(ctx.tx, input.id) : null;
    const courseId = old ? old.courseId : (input.courseId ?? null);
    let criteria: BadgeCriteriaT;
    try {
      criteria = checkCriteria(input.criteria, !courseId);
    } catch (e) {
      throw new ValidationError({
        criteria: [e instanceof Error ? e.message : msg('errors.badges.invalidCriteria')],
      });
    }
    await checkReferences(ctx.tx, criteria, courseId);
    if (input.expiry === 'days' && !input.expiresAfterDays)
      throw new ValidationError({ expiresAfterDays: [msg('errors.badges.enterDays')] });
    if (input.expiry === 'date' && !input.expiresAt)
      throw new ValidationError({ expiresAt: [msg('errors.badges.chooseDate')] });
    const data = {
      name: input.name,
      description: input.description,
      criteria: criteria as unknown as Prisma.InputJsonValue,
      expiresAfterDays: input.expiry === 'days' ? input.expiresAfterDays! : null,
      expiresAt: input.expiry === 'date' ? input.expiresAt! : null,
    };
    if (old) {
      // what earns the badge, and for how long, stays as it was for those who have it
      const awarded = await ctx.tx.badgeAward.count({ where: { badgeId: old.id } });
      const same =
        // parsed again: the stored JSON comes back with its keys in another order
        JSON.stringify(checkCriteria(old.criteria, !courseId)) === JSON.stringify(criteria) &&
        old.expiresAfterDays === data.expiresAfterDays &&
        (old.expiresAt?.getTime() ?? null) === (data.expiresAt?.getTime() ?? null);
      if (awarded && !same)
        throw new ValidationError({
          criteria: [msg('errors.badges.lockedAfterAward')],
        });
      await ctx.tx.badge.update({ where: { id: old.id }, data });
      return { id: old.id };
    }
    const b = await ctx.tx.badge.create({
      data: { ...data, courseId, createdById: ctx.perm.userId },
    });
    return { id: b.id };
  },
});

/** A badge image is a PNG or an SVG of at most 1 MB; which of the two it is. */
export function checkBadgeImage(data: Uint8Array): 'png' | 'svg' {
  const fail = (m: string) => {
    throw new ValidationError({ image: [m] }, m);
  };
  if (data.byteLength > BADGE_IMAGE_MAX_BYTES) fail('The image is larger than 1 MB');
  if (isPng(data)) return 'png';
  if (!isSvg(data)) fail('Upload a PNG or SVG image');
  return 'svg';
}

export const setBadgeImage = defineOperation({
  name: 'badge.image',
  input: z.object({
    id: z.string().uuid(),
    name: z.string().max(255),
    data: z.instanceof(Uint8Array),
  }),
  authorize: async (ctx, i) => requireManage(ctx, (await loadBadge(ctx.db, i.id)).courseId),
  async handler(ctx, input) {
    const b = await loadBadge(ctx.tx, input.id);
    const png = checkBadgeImage(input.data) === 'png';
    const where = {
      contextId: b.courseId ?? SYSTEM_CONTEXT_ID,
      component: 'badge',
      area: 'image',
      itemId: b.id,
    };
    await ctx.tx.file.deleteMany({ where });
    const f = await storeFile(ctx.tx, {
      ...where,
      name: (input.name || 'badge').replace(/\.[^.]*$/, '') + (png ? '.png' : '.svg'),
      mimeType: png ? 'image/png' : 'image/svg+xml',
      data: Buffer.from(input.data),
      uploadedById: ctx.perm.userId ?? null,
    });
    await ctx.tx.badge.update({ where: { id: b.id }, data: { imageFileId: f.id } });
    return { id: b.id, fileId: f.id };
  },
});

export const setBadgeStatus = defineOperation({
  name: 'badge.status',
  input: z.object({ id: z.string().uuid(), status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']) }),
  authorize: async (ctx, i) => requireManage(ctx, (await loadBadge(ctx.db, i.id)).courseId),
  async handler(ctx, { id, status }) {
    const b = await loadBadge(ctx.tx, id);
    if (status === 'ACTIVE') {
      const fail = (m: string) => {
        throw new ValidationError({ status: [m] }, m);
      };
      if (!b.imageFileId) fail('Add the badge image first');
      if (!checkCriteria(b.criteria, !b.courseId).rules.length) fail('Add criteria first');
    }
    if (status === 'DRAFT' && (await ctx.tx.badgeAward.count({ where: { badgeId: id } }))) {
      const m = 'An awarded badge is archived, not made a draft';
      throw new ValidationError({ status: [m] }, m);
    }
    await ctx.tx.badge.update({ where: { id }, data: { status } });
    // those who have earned it already get it
    if (status === 'ACTIVE') await enqueue(BADGES_REVIEW_JOB, { badgeId: id });
    await logEvent(ctx.tx, {
      name: 'badge.status',
      actorId: ctx.perm.userId,
      courseId: b.courseId,
      data: { badgeId: id, status },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { id, status };
  },
});

export const deleteBadge = defineOperation({
  name: 'badge.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: async (ctx, i) => requireManage(ctx, (await loadBadge(ctx.db, i.id)).courseId),
  async handler(ctx, { id }) {
    const b = await loadBadge(ctx.tx, id);
    if (await ctx.tx.badgeAward.count({ where: { badgeId: id } })) {
      const m = 'An awarded badge is archived, not deleted';
      throw new ValidationError({ id: [m] }, m);
    }
    await deleteFiles(ctx.tx, {
      contextId: b.courseId ?? SYSTEM_CONTEXT_ID,
      component: 'badge',
      area: 'image',
      itemId: id,
    });
    await ctx.tx.badge.delete({ where: { id } });
    return { id };
  },
});

/** Who issues the site's badges, as their Open Badges issuer names it. */
export const saveBadgeIssuer = defineOperation({
  name: 'badge.issuer',
  input: z.object({
    name: z.string().trim().max(255).default(''),
    email: z.union([z.literal(''), z.string().trim().email().max(255)]).default(''),
  }),
  authorize: (ctx) => ctx.perm.require('badge:managesite'),
  async handler(ctx, input) {
    await setSettings(
      ctx.tx,
      { 'badges.issuerName': input.name, 'badges.issuerEmail': input.email },
      ctx.perm.userId ?? undefined,
    );
    return null;
  },
});

// ── earning ──────────────────────────────────────────────────────────────────

async function factsFor(tx: Tx, badge: Badge, c: BadgeCriteriaT, userId: string) {
  const kinds = new Set(c.rules.map((r) => r.kind));
  const courseIds = [
    ...(badge.courseId && kinds.has('courseCompletion') ? [badge.courseId] : []),
    ...c.rules.flatMap((r) => (r.kind === 'courses' ? r.courseIds : [])),
  ];
  const activityIds = c.rules.flatMap((r) => (r.kind === 'activities' ? r.activityIds : []));
  const [completions, activities, marks, cohorts, grade] = await Promise.all([
    courseIds.length
      ? tx.courseCompletion.findMany({
          where: { userId, courseId: { in: courseIds }, completedAt: { not: null } },
          select: { courseId: true },
        })
      : [],
    activityIds.length
      ? tx.activityCompletion.findMany({
          where: {
            userId,
            activityId: { in: activityIds },
            state: { in: ['COMPLETE', 'COMPLETE_PASS'] },
          },
          select: { activityId: true },
        })
      : [],
    kinds.has('manual')
      ? tx.badgeMark.findMany({ where: { badgeId: badge.id, userId }, select: { roleId: true } })
      : [],
    kinds.has('cohort')
      ? tx.cohortMember.findMany({ where: { userId }, select: { cohortId: true } })
      : [],
    badge.courseId && kinds.has('courseGrade')
      ? courseGradePercent(tx, badge.courseId, userId)
      : null,
  ]);
  return {
    completedCourses: new Set(completions.map((x) => x.courseId)),
    completedActivities: new Set(activities.map((x) => x.activityId)),
    courseGradePercent: grade,
    markedByRoles: new Set(marks.map((x) => x.roleId)),
    cohorts: new Set(cohorts.map((x) => x.cohortId)),
  } satisfies BadgeFacts;
}

/** The recipient as the assertion names them: their email, or their id when they have none. */
async function recipientOf(tx: Tx, userId: string) {
  const u = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, emailPlaceholder: true },
  });
  return u.email && !u.emailPlaceholder
    ? { recipientType: 'email', recipientIdentity: u.email.trim().toLowerCase() }
    : { recipientType: 'id', recipientIdentity: `urn:uuid:${userId}` };
}

const isValid = (a: { revokedAt: Date | null; expiresAt: Date | null }, now: Date) =>
  !a.revokedAt && !(a.expiresAt && a.expiresAt <= now);

/**
 * Awards the badge when the learner has earned it and does not have it. A revoked or expired
 * award is given again only with `again`, when someone awards it by hand: a revoke is a
 * decision that earning the badge once more does not undo.
 */
export async function awardIfEarned(
  tx: Tx,
  badge: Badge,
  userId: string,
  opts: {
    now?: Date;
    awardedById?: string | null;
    again?: boolean;
    /** The course's learners, when the caller has them already (a review of many). */
    learners?: Set<string>;
  } = {},
): Promise<boolean> {
  if (badge.status !== 'ACTIVE') return false;
  const now = opts.now ?? new Date();
  const had = await tx.badgeAward.findUnique({
    where: { badgeId_userId: { badgeId: badge.id, userId } },
  });
  if (had && (!opts.again || isValid(had, now))) return false;
  const c = checkCriteria(badge.criteria, !badge.courseId);
  if (!criteriaMet(c, await factsFor(tx, badge, c, userId), badge.courseId)) return false;
  if (!(await mayEarn(tx, badge, userId, opts.learners))) return false;
  const expiresAt = badge.expiresAfterDays
    ? new Date(now.getTime() + badge.expiresAfterDays * 86_400_000)
    : badge.expiresAt;
  const data = {
    issuedAt: now,
    expiresAt,
    awardedById: opts.awardedById ?? null,
    ...(await recipientOf(tx, userId)),
  };
  // given again, the award keeps its address (and its salt), and stands once more
  let award: BadgeAward;
  if (had)
    award = await tx.badgeAward.update({
      where: { id: had.id },
      data: { ...data, revokedAt: null, revokedReason: null },
    });
  else {
    // awarded meanwhile by another run (completion and the hourly review at once): theirs
    // stands, and this transaction goes on instead of failing on the unique key
    const made = await tx.badgeAward.createMany({
      data: [{ ...data, badgeId: badge.id, userId, salt: randomBytes(12).toString('hex') }],
      skipDuplicates: true,
    });
    if (!made.count) return false;
    award = await tx.badgeAward.findUniqueOrThrow({
      where: { badgeId_userId: { badgeId: badge.id, userId } },
    });
  }
  await notifyUsers(tx, [userId], {
    type: 'badge.awarded',
    title: { key: 'notifications.text.badgeAwarded', values: { name: badge.name } },
    body: '',
    url: `/badge/${award.id}`,
    courseId: badge.courseId,
    data: { badgeId: badge.id, awardId: award.id },
  });
  await logEvent(tx, {
    name: 'badge.awarded',
    actorId: opts.awardedById ?? null,
    courseId: badge.courseId,
    relatedUserId: userId,
    data: { badgeId: badge.id, awardId: award.id, ...(had ? { again: true } : {}) },
  });
  return true;
}

/**
 * After completion changed in a course: its active badges, and the site badges that ask
 * for this course, for the learner.
 */
export async function checkCourseBadges(tx: Tx, courseId: string, userId: string) {
  const badges = await tx.badge.findMany({
    where: { status: 'ACTIVE', OR: [{ courseId }, { courseId: null }] },
  });
  for (const b of badges) {
    const rules = ((b.criteria as { rules?: BadgeRuleT[] }).rules ?? []) as BadgeRuleT[];
    const concerns = b.courseId
      ? true
      : rules.some((r) => r.kind === 'courses' && r.courseIds.includes(courseId));
    if (concerns) await awardIfEarned(tx, b, userId);
  }
}

/** Everyone who may have earned the badge and does not have it yet. */
async function candidates(tx: Tx, badge: Badge): Promise<string[]> {
  if (badge.courseId) return courseLearnerIds(tx, badge.courseId);
  const rules = checkCriteria(badge.criteria, true).rules;
  const ids = new Set<string>();
  for (const r of rules) {
    if (r.kind === 'courses')
      for (const c of await tx.courseCompletion.findMany({
        where: { courseId: { in: r.courseIds }, completedAt: { not: null } },
        select: { userId: true },
      }))
        ids.add(c.userId);
    if (r.kind === 'cohort')
      for (const m of await tx.cohortMember.findMany({
        where: { cohortId: { in: r.cohortIds } },
        select: { userId: true },
      }))
        ids.add(m.userId);
    if (r.kind === 'manual')
      for (const m of await tx.badgeMark.findMany({
        where: { badgeId: badge.id },
        select: { userId: true },
      }))
        ids.add(m.userId);
  }
  return [...ids];
}

/** Awards a badge to everyone who has earned it; the number awarded. */
export async function reviewBadge(db: Db, badgeId: string, now = new Date()): Promise<number> {
  const badge = await db.badge.findUnique({ where: { id: badgeId } });
  if (badge?.status !== 'ACTIVE') return 0;
  const have = new Set(
    (await db.badgeAward.findMany({ where: { badgeId }, select: { userId: true } })).map(
      (a) => a.userId,
    ),
  );
  // the course's learners once for the whole review, and a transaction only for those who
  // have earned the badge
  const learners = badge.courseId ? new Set(await courseLearnerIds(db, badge.courseId)) : undefined;
  const c = checkCriteria(badge.criteria, !badge.courseId);
  let n = 0;
  for (const userId of await candidates(db, badge)) {
    if (have.has(userId)) continue;
    if (learners && !learners.has(userId)) continue;
    if (!criteriaMet(c, await factsFor(db, badge, c, userId), badge.courseId)) continue;
    if (await db.$transaction((tx) => awardIfEarned(tx, badge, userId, { now, learners }))) n++;
  }
  return n;
}

/**
 * Cron (hourly): every active badge, for what completion events do not cover. A badge that
 * fails is logged and left for the next run; the others are reviewed all the same.
 */
export async function reviewAllBadges(db: Db, now = new Date()): Promise<number> {
  let n = 0;
  const badges = await db.badge.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const b of badges) {
    try {
      n += await reviewBadge(db, b.id, now);
    } catch (e) {
      logger.error({ err: e, badgeId: b.id }, 'badge review failed');
    }
  }
  return n;
}

// ── by hand ──────────────────────────────────────────────────────────────────

/** The badge's manual roles the person holds where it is awarded (all of them for admins). */
async function rolesOf(ctx: RequestContext, badge: Badge, roleIds: string[]) {
  if (ctx.perm.isSiteAdmin) return roleIds;
  const contexts = [SYSTEM_CONTEXT_ID, ...(badge.courseId ? [badge.courseId] : [])];
  const rows = await ctx.db.roleAssignment.findMany({
    where: { userId: ctx.perm.userId ?? '', contextId: { in: contexts }, roleId: { in: roleIds } },
    select: { roleId: true },
  });
  return [...new Set(rows.map((r) => r.roleId))];
}

/** Awards a badge by hand: recorded for the giver's roles; the badge follows its criteria. */
export const markBadge = defineOperation({
  name: 'badge.mark',
  input: z.object({ badgeId: z.string().uuid(), userId: z.string().uuid() }),
  authorize: async (ctx, i) => requireAward(ctx, (await loadBadge(ctx.db, i.badgeId)).courseId),
  async handler(ctx, { badgeId, userId }) {
    const badge = await loadBadge(ctx.tx, badgeId);
    if (badge.status !== 'ACTIVE')
      throw new ValidationError({ badgeId: [msg('errors.badges.notActive')] });
    const rule = checkCriteria(badge.criteria, !badge.courseId).rules.find(
      (r) => r.kind === 'manual',
    );
    if (rule?.kind !== 'manual')
      throw new ValidationError({ badgeId: [msg('errors.badges.notManual')] });
    const roles = await rolesOf(ctx, badge, rule.roleIds);
    if (!roles.length) throw new ForbiddenError(msg('errors.badges.noAwardingRole'));
    if (!(await mayEarn(ctx.tx, badge, userId)))
      throw new ValidationError({ userId: [msg('errors.badges.cannotEarn')] });
    for (const roleId of roles)
      await ctx.tx.badgeMark.upsert({
        where: { badgeId_userId_roleId: { badgeId, userId, roleId } },
        create: { badgeId, userId, roleId, markedById: ctx.perm.userId },
        update: {},
      });
    const awarded = await awardIfEarned(ctx.tx, badge, userId, {
      now: ctx.now,
      awardedById: ctx.perm.userId,
      again: true,
    });
    return { awarded };
  },
});

/** Gives a revoked or expired award again, when its learner still meets the criteria. */
export const awardBadgeAgain = defineOperation({
  name: 'badge.awardAgain',
  input: z.object({ awardId: z.string().uuid() }),
  async authorize(ctx, i) {
    const a = await ctx.db.badgeAward.findUnique({
      where: { id: i.awardId },
      include: { badge: { select: { courseId: true } } },
    });
    if (!a) throw new NotFoundError('Award');
    await requireAward(ctx, a.badge.courseId);
  },
  async handler(ctx, { awardId }) {
    const a = await ctx.tx.badgeAward.findUniqueOrThrow({
      where: { id: awardId },
      include: { badge: true },
    });
    if (isValid(a, ctx.now))
      throw new ValidationError({ awardId: [msg('errors.badges.stillValid')] });
    if (a.badge.status !== 'ACTIVE')
      throw new ValidationError({ awardId: [msg('errors.badges.notActive')] });
    const awarded = await awardIfEarned(ctx.tx, a.badge, a.userId, {
      now: ctx.now,
      awardedById: ctx.perm.userId,
      again: true,
    });
    if (!awarded) throw new ValidationError({ awardId: [msg('errors.badges.criteriaNotMet')] });
    return { id: awardId };
  },
});

export const revokeBadgeAward = defineOperation({
  name: 'badge.revoke',
  input: z.object({ awardId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }),
  async authorize(ctx, i) {
    const a = await ctx.db.badgeAward.findUnique({
      where: { id: i.awardId },
      include: { badge: { select: { courseId: true } } },
    });
    if (!a) throw new NotFoundError('Award');
    await requireAward(ctx, a.badge.courseId);
  },
  async handler(ctx, { awardId, reason }) {
    const a = await ctx.tx.badgeAward.update({
      where: { id: awardId },
      data: { revokedAt: ctx.now, revokedReason: reason },
      include: { badge: { select: { courseId: true } } },
    });
    await logEvent(ctx.tx, {
      name: 'badge.revoked',
      actorId: ctx.perm.userId,
      courseId: a.badge.courseId,
      relatedUserId: a.userId,
      data: { awardId, reason },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { id: awardId };
  },
});

// ── reading ──────────────────────────────────────────────────────────────────

/** The badges of a course (or the site): all for managers; for the others what is awarded and what they have. */
export async function listBadges(ctx: RequestContext, courseId: string | null) {
  // a course's badges are for those who may see the course
  if (courseId) await requireCourseView(ctx, courseId);
  const manage = courseId
    ? await ctx.perm.can('badge:manage', courseId)
    : await ctx.perm.can('badge:managesite');
  const viewAwards = courseId ? await ctx.perm.can('badge:viewawards', courseId) : manage;
  const badges = await ctx.db.badge.findMany({
    where: {
      courseId,
      ...(manage
        ? {}
        : {
            OR: [
              { status: 'ACTIVE' as const },
              { status: 'ARCHIVED' as const, awards: { some: { userId: ctx.perm.userId ?? '' } } },
            ],
          }),
    },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { awards: { where: { revokedAt: null } } } } },
  });
  const mine = ctx.perm.userId
    ? await ctx.db.badgeAward.findMany({
        where: { userId: ctx.perm.userId, badgeId: { in: badges.map((b) => b.id) } },
      })
    : [];
  return {
    manage,
    viewAwards,
    badges: badges.map((b) => ({
      ...b,
      criteria: checkCriteria(b.criteria, !b.courseId),
      awarded: b._count.awards,
      mine: mine.find((a) => a.badgeId === b.id) ?? null,
    })),
  };
}

/** A badge with a page of its awards (the latest first), for those who manage or award it. */
export async function badgeDetail(
  ctx: RequestContext,
  id: string,
  opts: { page?: number; pageSize?: number } = {},
) {
  const b = await loadBadge(ctx.db, id);
  const viewAwards = b.courseId
    ? await ctx.perm.can('badge:viewawards', b.courseId)
    : await ctx.perm.can('badge:managesite');
  if (!viewAwards) throw new ForbiddenError();
  const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const [total, awards, manage, award] = await Promise.all([
    ctx.db.badgeAward.count({ where: { badgeId: id } }),
    ctx.db.badgeAward.findMany({
      where: { badgeId: id },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    b.courseId ? ctx.perm.can('badge:manage', b.courseId) : ctx.perm.can('badge:managesite'),
    b.courseId ? ctx.perm.can('badge:award', b.courseId) : ctx.perm.can('badge:managesite'),
  ]);
  const criteria = checkCriteria(b.criteria, !b.courseId);
  const manual = criteria.rules.find((r) => r.kind === 'manual');
  // people the badge can be awarded to by hand (course badges: the course's learners)
  let awardable: { id: string; name: string }[] = [];
  if (award && manual && b.status === 'ACTIVE' && b.courseId) {
    // a revoked or expired award can be given again
    const holding = new Set(
      (
        await ctx.db.badgeAward.findMany({
          where: {
            badgeId: id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: ctx.now } }],
          },
          select: { userId: true },
        })
      ).map((a) => a.userId),
    );
    awardable = await ctx.db.user.findMany({
      where: {
        id: { in: (await courseLearnerIds(ctx.db, b.courseId)).filter((u) => !holding.has(u)) },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
  return { badge: { ...b, criteria }, awards, total, page, pageSize, manage, award, awardable };
}

/** A person's badges (revoked ones too: they say so). */
export async function userBadges(db: Tx, userId: string) {
  return db.badgeAward.findMany({
    where: { userId },
    include: { badge: { include: { course: { select: { id: true, fullName: true } } } } },
    orderBy: { issuedAt: 'desc' },
  });
}

// ── Open Badges documents ────────────────────────────────────────────────────

/** The site's address, which badges' public documents are under. */
export const badgeOrigin = () => getEnv().APP_URL.replace(/\/+$/, '');

export const badgeUrls = (origin: string) => ({
  issuer: `${origin}/api/badges/issuer`,
  badgeClass: (id: string) => `${origin}/api/badges/classes/${id}`,
  image: (id: string) => `${origin}/api/badges/images/${id}`,
  assertion: (id: string) => `${origin}/api/badges/assertions/${id}`,
  baked: (id: string) => `${origin}/api/badges/assertions/${id}/image`,
  awardPage: (id: string) => `${origin}/badge/${id}`,
  classPage: (id: string) => `${origin}/badge/class/${id}`,
});

export async function issuerDocument(db: Tx, origin: string) {
  const s = await getAllSettings(db);
  return issuerJson({
    id: badgeUrls(origin).issuer,
    name: s['badges.issuerName'] || s['site.name'],
    url: origin,
    email: s['badges.issuerEmail'] || undefined,
  });
}

/** The criteria in words: in the site language for the badge class, or in the reader's. */
export async function criteriaNarrative(
  db: Tx,
  badge: { courseId: string | null; criteria: unknown },
  locale?: string,
): Promise<string> {
  const lang = locale ?? siteLocale(await getAllSettings(db));
  const t = createTranslator(lang);
  const c = checkCriteria(badge.criteria, !badge.courseId);
  const names = async (ids: string[], kind: 'activity' | 'course' | 'role' | 'cohort') => {
    const rows =
      kind === 'activity'
        ? await db.activity.findMany({ where: { id: { in: ids } }, select: { name: true } })
        : kind === 'course'
          ? (
              await db.course.findMany({ where: { id: { in: ids } }, select: { fullName: true } })
            ).map((x) => ({ name: x.fullName }))
          : kind === 'cohort'
            ? await db.cohort.findMany({ where: { id: { in: ids } }, select: { name: true } })
            : (
                await db.role.findMany({
                  where: { id: { in: ids } },
                  select: { name: true, shortName: true },
                })
              ).map((r) => ({ name: roleName(r, lang) }));
    return rows.map((r) => r.name).join(', ');
  };
  const parts: string[] = [];
  for (const r of c.rules) {
    const m = 'method' in r ? r.method : 'all';
    if (r.kind === 'courseCompletion') parts.push(t('badges.narrative.courseCompletion'));
    if (r.kind === 'courseGrade')
      parts.push(t('badges.narrative.courseGrade', { percent: r.minPercent }));
    if (r.kind === 'activities')
      parts.push(
        t(`badges.narrative.activities.${m}`, { list: await names(r.activityIds, 'activity') }),
      );
    if (r.kind === 'courses')
      parts.push(t(`badges.narrative.courses.${m}`, { list: await names(r.courseIds, 'course') }));
    if (r.kind === 'cohort')
      parts.push(t(`badges.narrative.cohort.${m}`, { list: await names(r.cohortIds, 'cohort') }));
    if (r.kind === 'manual')
      parts.push(t(`badges.narrative.manual.${m}`, { list: await names(r.roleIds, 'role') }));
  }
  return parts.join(c.method === 'all' ? t('badges.narrative.and') : t('badges.narrative.or'));
}

export async function badgeClassDocument(db: Tx, origin: string, id: string) {
  const b = await db.badge.findUnique({ where: { id } });
  if (!b || b.status === 'DRAFT') return null;
  const u = badgeUrls(origin);
  return badgeClassJson({
    id: u.badgeClass(b.id),
    name: b.name,
    description: b.description,
    image: u.image(b.id),
    criteriaUrl: u.classPage(b.id),
    criteriaNarrative: await criteriaNarrative(db, b),
    issuer: u.issuer,
  });
}

/** The assertion, or what a revoked one answers (status 410); null when there is none. */
export async function assertionDocument(db: Tx, origin: string, awardId: string) {
  const a = await db.badgeAward.findUnique({ where: { id: awardId } });
  if (!a) return null;
  const u = badgeUrls(origin);
  if (a.revokedAt)
    return { status: 410, body: revokedJson(u.assertion(a.id), a.revokedReason ?? '') };
  return {
    status: 200,
    body: assertionJson({
      id: u.assertion(a.id),
      badge: u.badgeClass(a.badgeId),
      recipientType: a.recipientType === 'email' ? 'email' : 'id',
      salt: a.salt,
      identity: a.recipientIdentity,
      issuedOn: a.issuedAt,
      expires: a.expiresAt,
      image: u.baked(a.id),
    }),
  };
}

/** The badge's image as stored. */
export async function badgeImage(db: Tx, badgeId: string) {
  const b = await db.badge.findUnique({ where: { id: badgeId } });
  if (!b?.imageFileId || b.status === 'DRAFT') return null;
  return db.file.findUnique({ where: { id: b.imageFileId }, include: { blob: true } });
}

/** The badge image of an award baked with its assertion (not for revoked awards). */
export async function bakedBadgeImage(db: Tx, origin: string, awardId: string) {
  const a = await db.badgeAward.findUnique({ where: { id: awardId } });
  const doc = a ? await assertionDocument(db, origin, a.id) : null;
  if (!a || doc?.status !== 200) return null;
  const file = await badgeImage(db, a.badgeId);
  if (!file) return null;
  const data = await buffer(await getStorage().getStream(file.blob.storageKey));
  const json = JSON.stringify(doc.body);
  const svg = file.mimeType === 'image/svg+xml';
  return {
    data: svg
      ? Buffer.from(bakeSvg(data.toString('utf8'), badgeUrls(origin).assertion(a.id), json))
      : Buffer.from(bakePng(data, json)),
    mimeType: svg ? 'image/svg+xml' : 'image/png',
    name: file.name,
  };
}

/** An award as its public page shows it. */
export async function publicAward(db: Tx, awardId: string) {
  return db.badgeAward.findUnique({
    where: { id: awardId },
    include: {
      user: { select: { name: true } },
      badge: { include: { course: { select: { id: true, fullName: true } } } },
    },
  });
}
