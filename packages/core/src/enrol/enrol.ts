import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db, EnrolmentMethodType, Prisma } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { separateGroupsOf } from '../groups/visibility.ts';
import { optionalText } from '../lib/zod.ts';
import { leaveGroupChats } from '../messaging/messaging.ts';
import { buildModuleCtx } from '../modules/module-ctx.ts';
import { listModules } from '../modules/registry.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';

type Tx = Prisma.TransactionClient | Db;

function keysEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Creates the enrolment and its role assignment. Idempotent per (method, user). */
export async function enrolUserRecord(
  tx: Tx,
  opts: {
    courseId: string;
    methodId: string;
    userId: string;
    roleId: string;
    createdById?: string | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
    component?: 'ENROL' | 'COHORT';
    /** Log user.enrolled when this enrols them (paths that do not log it themselves). */
    log?: { ctx: Pick<RequestContext, 'perm' | 'origin'>; method: string };
  },
) {
  const existing = await tx.enrolment.findUnique({
    where: { methodId_userId: { methodId: opts.methodId, userId: opts.userId } },
  });
  const enrolment = existing
    ? await tx.enrolment.update({
        where: { id: existing.id },
        data: {
          status: 'ACTIVE',
          startsAt: opts.startsAt !== undefined ? opts.startsAt : existing.startsAt,
          endsAt: opts.endsAt !== undefined ? opts.endsAt : existing.endsAt,
        },
      })
    : await tx.enrolment.create({
        data: {
          methodId: opts.methodId,
          courseId: opts.courseId,
          userId: opts.userId,
          createdById: opts.createdById ?? null,
          startsAt: opts.startsAt ?? null,
          endsAt: opts.endsAt ?? null,
        },
      });
  const ra = await tx.roleAssignment.findFirst({ where: { enrolmentId: enrolment.id } });
  // a new enrolment, or one active again
  if (opts.log && existing?.status !== 'ACTIVE')
    await logEnrolments(tx, opts.log.ctx, 'enrolled', opts.courseId, [opts.userId], {
      method: opts.log.method,
    });
  if (!ra) {
    await tx.roleAssignment.create({
      data: {
        userId: opts.userId,
        roleId: opts.roleId,
        contextId: opts.courseId,
        component: opts.component ?? 'ENROL',
        enrolmentId: enrolment.id,
      },
    });
  }
  return enrolment;
}

/**
 * user.enrolled or user.unenrolled for each of `userIds`, with the method's type: the
 * course log shows who joined and left, and the enrolment.created and enrolment.deleted
 * webhooks follow, whichever path enrols or unenrols them.
 */
export async function logEnrolments(
  tx: Tx,
  ctx: Pick<RequestContext, 'perm' | 'origin'>,
  change: 'enrolled' | 'unenrolled',
  courseId: string,
  userIds: Iterable<string>,
  data: { method: string } & Record<string, Prisma.InputJsonValue | null>,
) {
  for (const userId of new Set(userIds))
    await logEvent(tx, {
      name: `user.${change}`,
      actorId: ctx.perm.userId ?? null,
      courseId,
      relatedUserId: userId,
      data,
      origin: ctx.origin,
    });
}

/** How a method is named in events and webhooks: manual, self, cohort. */
export const methodName = (type: EnrolmentMethodType) => type.toLowerCase();

async function manualMethod(tx: Tx, courseId: string) {
  const m = await tx.enrolmentMethod.findFirst({
    where: { courseId, type: 'MANUAL' },
    orderBy: { sortOrder: 'asc' },
  });
  if (!m) throw new NotFoundError('Manual enrolment method');
  return m;
}

export const enrolUsers = defineOperation({
  name: 'enrol.manual',
  input: z.object({
    courseId: z.string().uuid(),
    userIds: z.array(z.string().uuid()).min(1).max(1000),
    roleId: z.string().uuid(),
    endsAt: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v) : null)),
  }),
  authorize: (ctx, i) => ctx.perm.require('enrol:manage', i.courseId),
  async handler(ctx, input) {
    const role = await assertCourseRole(ctx, input.courseId, input.roleId);
    const method = await manualMethod(ctx.tx, input.courseId);
    for (const userId of input.userIds) {
      await enrolUserRecord(ctx.tx, {
        courseId: input.courseId,
        methodId: method.id,
        userId,
        roleId: role.id,
        createdById: ctx.perm.userId,
        endsAt: input.endsAt,
      });
      await logEvent(ctx.tx, {
        name: 'user.enrolled',
        actorId: ctx.perm.userId,
        courseId: input.courseId,
        relatedUserId: userId,
        data: { roleId: role.id, method: 'manual' },
        origin: ctx.origin,
      });
    }
    // Seeding and sync jobs run as system and stay quiet.
    if (ctx.actor.kind === 'user') {
      const course = await ctx.tx.course.findUniqueOrThrow({
        where: { id: input.courseId },
        select: { fullName: true },
      });
      await notifyUsers(ctx.tx, input.userIds, {
        type: 'enrol.enrolled',
        title: { key: 'notifications.text.enrolled', values: { course: course.fullName } },
        url: `/course/${input.courseId}`,
        courseId: input.courseId,
        actorId: ctx.perm.userId,
      });
    }
    return { count: input.userIds.length };
  },
});

/** Site admins may assign any role; others follow RoleAssignRule for roles they hold here. */
export async function assertCanAssignRole(ctx: RequestContext, contextId: string, roleId: string) {
  if (ctx.actor.kind === 'system' || ctx.perm.isSiteAdmin) return;
  const userId = ctx.perm.userId;
  if (!userId) throw new ForbiddenError();
  const mine = await ctx.db.roleAssignment.findMany({
    where: {
      userId,
      contextId: {
        in: [
          ...(await ctx.db.context.findUniqueOrThrow({ where: { id: contextId } })).ancestorIds,
          contextId,
        ],
      },
    },
    select: { roleId: true },
  });
  const allowed = await ctx.db.roleAssignRule.findFirst({
    where: { roleId: { in: mine.map((m) => m.roleId) }, assignableRoleId: roleId },
  });
  if (!allowed) throw new ForbiddenError('You cannot assign this role');
}

/** The role exists, may be given in a course, and the caller may assign it there. */
export async function assertCourseRole(ctx: RequestContext, courseId: string, roleId: string) {
  const role = await ctx.db.role.findUnique({ where: { id: roleId } });
  if (!role?.assignableLevels.includes('COURSE'))
    throw new ValidationError({ roleId: ['Role cannot be assigned in a course'] });
  await assertCanAssignRole(ctx, courseId, role.id);
  return role;
}

/** Leaves groups and lets modules clean up once the user has no enrolment left in a course. */
export async function removeCourseMembership(
  ctx: RequestContext,
  tx: Prisma.TransactionClient,
  courseId: string,
  userId: string,
) {
  await tx.groupMember.deleteMany({ where: { userId, group: { courseId } } });
  await leaveGroupChats(tx, { courseId }, [userId]);
  const mctx = buildModuleCtx(ctx, tx);
  for (const m of listModules()) await m.lifecycle?.onUserUnenrolled?.(mctx, courseId, userId);
}

export const unenrolUser = defineOperation({
  name: 'enrol.unenrol',
  input: z.object({ courseId: z.string().uuid(), userId: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('enrol:manage', i.courseId),
  async handler(ctx, { courseId, userId }) {
    const enrolments = await ctx.tx.enrolment.findMany({
      where: { courseId, userId },
      include: { method: { select: { type: true } } },
    });
    if (!enrolments.length) throw new NotFoundError('Enrolment');
    await ctx.tx.roleAssignment.deleteMany({
      where: { enrolmentId: { in: enrolments.map((e) => e.id) } },
    });
    await ctx.tx.roleAssignment.deleteMany({ where: { userId, contextId: courseId } });
    await ctx.tx.enrolment.deleteMany({ where: { courseId, userId } });
    await removeCourseMembership(ctx, ctx.tx, courseId, userId);
    // one for each way they were enrolled
    for (const e of enrolments)
      await logEnrolments(ctx.tx, ctx, 'unenrolled', courseId, [userId], {
        method: methodName(e.method.type),
      });
    return { userId };
  },
});

export const setEnrolmentStatus = defineOperation({
  name: 'enrol.status',
  input: z.object({
    courseId: z.string().uuid(),
    userId: z.string().uuid(),
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    endsAt: z
      .string()
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v ? new Date(v) : null)),
  }),
  authorize: (ctx, i) => ctx.perm.require('enrol:manage', i.courseId),
  async handler(ctx, { courseId, userId, status, endsAt }) {
    const r = await ctx.tx.enrolment.updateMany({
      where: { courseId, userId },
      data: { status, ...(endsAt !== undefined ? { endsAt } : {}) },
    });
    if (!r.count) throw new NotFoundError('Enrolment');
    return { userId };
  },
});

/**
 * Replaces the user's course roles (keeps the enrolment). Roles the caller cannot assign
 * cannot be removed either; cohort-synced roles follow the cohort and are left alone.
 */
export const setCourseRoles = defineOperation({
  name: 'enrol.roles',
  input: z.object({
    courseId: z.string().uuid(),
    userId: z.string().uuid(),
    roleIds: z.array(z.string().uuid()).min(1),
  }),
  authorize: (ctx, i) => ctx.perm.require('role:assign', i.courseId),
  async handler(ctx, { courseId, userId, roleIds }) {
    for (const r of roleIds) await assertCourseRole(ctx, courseId, r);
    // New roles follow the user's current enrolment, so they end when it does.
    const enrolments = await ctx.tx.enrolment.findMany({
      where: { courseId, userId },
      orderBy: { createdAt: 'asc' },
    });
    const enrolment =
      enrolments.find((e) => e.status === 'ACTIVE' && !(e.endsAt && e.endsAt <= ctx.now)) ??
      enrolments[0];
    if (!enrolment) throw new NotFoundError('Enrolment');
    const held = await ctx.tx.roleAssignment.findMany({
      where: { userId, contextId: courseId },
    });
    const remove = held.filter((a) => !roleIds.includes(a.roleId) && a.component !== 'COHORT');
    for (const a of remove) await assertCanAssignRole(ctx, courseId, a.roleId);
    await ctx.tx.roleAssignment.deleteMany({ where: { id: { in: remove.map((a) => a.id) } } });
    for (const roleId of roleIds) {
      if (held.some((a) => a.roleId === roleId)) continue;
      await ctx.tx.roleAssignment.create({
        data: {
          userId,
          roleId,
          contextId: courseId,
          component: 'ENROL',
          enrolmentId: enrolment.id,
        },
      });
    }
    await logEvent(ctx.tx, {
      name: 'role.assigned',
      actorId: ctx.perm.userId,
      courseId,
      relatedUserId: userId,
      data: { roleIds },
      origin: ctx.origin,
    });
    return { userId };
  },
});

// ── self enrolment ────────────────────────────────────────────────────────────

export const SelfMethodSettings = z.object({
  enabled: z.boolean(),
  key: optionalText(100),
  useGroupKeys: z.boolean().default(false),
  startsAt: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : null)),
  endsAt: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : null)),
  durationDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .optional()
    .transform((v) => v || null),
  maxEnrolled: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .transform((v) => v || null),
  welcome: z.string().max(5000).default(''),
});

export const updateSelfEnrolment = defineOperation({
  name: 'enrol.self.configure',
  input: SelfMethodSettings.extend({ courseId: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('enrol:manage', i.courseId),
  async handler(ctx, input) {
    const student = await ctx.tx.role.findUniqueOrThrow({ where: { shortName: 'student' } });
    const existing = await ctx.tx.enrolmentMethod.findFirst({
      where: { courseId: input.courseId, type: 'SELF' },
    });
    const data = {
      enabled: input.enabled,
      key: input.key ?? null,
      useGroupKeys: input.useGroupKeys,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      durationDays: input.durationDays,
      maxEnrolled: input.maxEnrolled,
      welcome: input.welcome,
    };
    if (existing) await ctx.tx.enrolmentMethod.update({ where: { id: existing.id }, data });
    else
      await ctx.tx.enrolmentMethod.create({
        data: { ...data, courseId: input.courseId, type: 'SELF', roleId: student.id, sortOrder: 1 },
      });
    return { ok: true };
  },
});

export const selfEnrol = defineOperation({
  name: 'enrol.self',
  input: z.object({ courseId: z.string().uuid(), key: z.string().max(100).optional() }),
  async authorize(ctx, i) {
    if (ctx.actor.kind !== 'user') throw new ForbiddenError('Sign in to enrol');
    await ctx.perm.require('enrol:self', i.courseId);
  },
  async handler(ctx, { courseId, key }) {
    const userId = ctx.perm.userId!;
    const course = await ctx.tx.course.findUnique({ where: { id: courseId } });
    if (!course || course.deletedAt || !course.visible) throw new NotFoundError('Course');
    const method = await ctx.tx.enrolmentMethod.findFirst({
      where: { courseId, type: 'SELF', enabled: true },
    });
    if (!method) throw new ForbiddenError('Self enrolment is not available');
    if (method.startsAt && method.startsAt > ctx.now)
      throw new ValidationError({ key: ['Enrolment has not opened yet'] });
    if (method.endsAt && method.endsAt <= ctx.now)
      throw new ValidationError({ key: ['Enrolment is closed'] });
    const mine = await ctx.tx.enrolment.findMany({ where: { courseId, userId } });
    const expired = (e: (typeof mine)[number]) => !!e.endsAt && e.endsAt <= ctx.now;
    // Suspended by a teacher (rather than run out): signing up again must not undo it.
    if (mine.some((e) => e.status === 'SUSPENDED' && !expired(e)))
      throw new ForbiddenError('Your enrolment in this course is suspended');
    if (mine.some((e) => e.status === 'ACTIVE' && !expired(e))) {
      throw new ConflictError('You are already enrolled');
    }
    if (method.maxEnrolled) {
      const n = await ctx.tx.enrolment.count({
        where: { methodId: method.id, userId: { not: userId } },
      });
      if (n >= method.maxEnrolled) throw new ValidationError({ key: ['The course is full'] });
    }
    let groupId: string | null = null;
    if (method.key) {
      const given = (key ?? '').trim();
      if (!given) throw new ValidationError({ key: ['Enrolment key is required'] });
      if (!keysEqual(given, method.key)) {
        if (method.useGroupKeys) {
          const groups = await ctx.tx.group.findMany({
            where: { courseId, enrolmentKey: { not: null } },
          });
          const g = groups.find((x) => x.enrolmentKey && keysEqual(given, x.enrolmentKey));
          if (!g) throw new ValidationError({ key: ['Wrong enrolment key'] });
          groupId = g.id;
        } else {
          throw new ValidationError({ key: ['Wrong enrolment key'] });
        }
      }
    }
    const endsAt = method.durationDays
      ? new Date(ctx.now.getTime() + method.durationDays * 86_400_000)
      : null;
    await enrolUserRecord(ctx.tx, {
      courseId,
      methodId: method.id,
      userId,
      roleId: method.roleId,
      createdById: userId,
      endsAt,
    });
    if (groupId) {
      await ctx.tx.groupMember.upsert({
        where: { groupId_userId: { groupId, userId } },
        create: { groupId, userId, component: 'enrol_self' },
        update: {},
      });
    }
    await logEvent(ctx.tx, {
      name: 'user.enrolled',
      actorId: userId,
      courseId,
      relatedUserId: userId,
      data: { method: 'self', groupId },
      origin: ctx.origin,
    });
    return { courseId, welcome: method.welcome };
  },
});

export const unenrolSelf = defineOperation({
  name: 'enrol.self.leave',
  input: z.object({ courseId: z.string().uuid() }),
  async handler(ctx, { courseId }) {
    const userId = ctx.perm.userId;
    if (!userId) throw new ForbiddenError();
    const self = await ctx.tx.enrolment.findMany({
      where: { courseId, userId, method: { type: 'SELF' } },
    });
    if (!self.length) throw new ForbiddenError('Only self-enrolled users can leave the course');
    await ctx.tx.roleAssignment.deleteMany({
      where: { enrolmentId: { in: self.map((e) => e.id) } },
    });
    await ctx.tx.enrolment.deleteMany({ where: { id: { in: self.map((e) => e.id) } } });
    if (!(await ctx.tx.enrolment.count({ where: { courseId, userId } })))
      await removeCourseMembership(ctx, ctx.tx, courseId, userId);
    await logEnrolments(ctx.tx, ctx, 'unenrolled', courseId, [userId], { method: 'self' });
    return { courseId };
  },
});

// ── participants ──────────────────────────────────────────────────────────────

export const ParticipantsQuery = z.object({
  courseId: z.string().uuid(),
  q: z.string().trim().max(100).optional(),
  roleId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export async function listParticipants(
  ctx: RequestContext,
  raw: z.input<typeof ParticipantsQuery>,
) {
  const q = ParticipantsQuery.parse(raw);
  await ctx.perm.require('course:viewparticipants', q.courseId);
  // Separate groups: users without group:accessall see only their groups' members, and
  // asking for another group gives nobody.
  const restrictGroups = (await separateGroupsOf(ctx, q.courseId)) ?? undefined;
  const groupFilter = restrictGroups
    ? { in: q.groupId ? restrictGroups.filter((g) => g === q.groupId) : restrictGroups }
    : q.groupId;
  // Contact details (and searching by them) only for people who manage the course roster.
  const showEnrolments = await ctx.perm.can('enrol:manage', q.courseId);
  const showContacts = showEnrolments || (await ctx.perm.can('user:viewdetails', q.courseId));
  // Whether someone's enrolment is suspended or when it ends is for those managing them,
  // not for their classmates: neither shown nor searchable by others.
  const status = showEnrolments ? q.status : undefined;
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    enrolments: { some: { courseId: q.courseId, ...(status ? { status } : {}) } },
    ...(q.roleId ? { roleAssignments: { some: { contextId: q.courseId, roleId: q.roleId } } } : {}),
    ...(groupFilter ? { groupMembers: { some: { groupId: groupFilter } } } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            ...(showContacts
              ? [
                  { email: { contains: q.q, mode: 'insensitive' as const } },
                  { username: { contains: q.q, mode: 'insensitive' as const } },
                ]
              : []),
          ],
        }
      : {}),
  };
  const [total, users] = await Promise.all([
    ctx.db.user.count({ where }),
    ctx.db.user.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        name: true,
        email: true,
        emailPlaceholder: true,
        username: true,
        image: true,
        enrolments: {
          where: { courseId: q.courseId },
          include: { method: { select: { type: true } } },
        },
        roleAssignments: { where: { contextId: q.courseId }, include: { role: true } },
        groupMembers: {
          where: { group: { courseId: q.courseId } },
          include: { group: { select: { id: true, name: true } } },
        },
        courseAccesses: { where: { courseId: q.courseId }, select: { lastAccessAt: true } },
      },
    }),
  ]);
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    showContacts,
    showEnrolments,
    users: users.map((u) => ({
      ...u,
      ...(showContacts ? {} : { email: '', emailPlaceholder: true, username: null }),
      enrolments: showEnrolments ? u.enrolments : [],
    })),
  };
}

/** Users not yet enrolled, for the "enrol users" picker. */
export async function searchEnrollableUsers(ctx: RequestContext, courseId: string, q: string) {
  await ctx.perm.require('enrol:manage', courseId);
  const term = q.trim();
  if (term.length < 2) return [];
  return ctx.db.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      kind: 'PERSON',
      enrolments: { none: { courseId } },
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { username: { contains: term, mode: 'insensitive' } },
      ],
    },
    take: 20,
    orderBy: { lastName: 'asc' },
    select: { id: true, name: true, email: true, emailPlaceholder: true, username: true },
  });
}

/** Ends enrolments whose end date passed (worker cron). */
export async function expireEnrolments(db: Db, now = new Date()): Promise<number> {
  const r = await db.enrolment.updateMany({
    where: { status: 'ACTIVE', endsAt: { lte: now } },
    data: { status: 'SUSPENDED' },
  });
  return r.count;
}
