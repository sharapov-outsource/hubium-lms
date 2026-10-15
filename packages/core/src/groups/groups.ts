import { type Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { dropAvailabilityRefs, namesGroupings, namesGroups } from '../courses/availability-refs.ts';
import { assertCourseRole, enrolUserRecord, removeCourseMembership } from '../enrol/enrol.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { optionalText } from '../lib/zod.ts';
import { leaveGroupChats } from '../messaging/messaging.ts';
import { defineOperation } from '../operation.ts';
import { separateGroupsOf } from './visibility.ts';

const GroupInput = z.object({
  courseId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(5000).default(''),
  enrolmentKey: optionalText(100),
  idNumber: optionalText(100),
});

export const createGroup = defineOperation({
  name: 'group.create',
  input: GroupInput,
  authorize: (ctx, i) => ctx.perm.require('group:manage', i.courseId),
  async handler(ctx, input) {
    if (await ctx.tx.group.findFirst({ where: { courseId: input.courseId, name: input.name } })) {
      throw new ValidationError({ name: ['A group with this name already exists'] });
    }
    const g = await ctx.tx.group.create({
      data: { ...input, enrolmentKey: input.enrolmentKey ?? null },
    });
    await logEvent(ctx.tx, {
      name: 'group.created',
      actorId: ctx.perm.userId,
      courseId: input.courseId,
      objectId: g.id,
      origin: ctx.origin,
    });
    return { id: g.id };
  },
});

export const updateGroup = defineOperation({
  name: 'group.update',
  input: GroupInput.omit({ courseId: true }).extend({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const g = await ctx.db.group.findUnique({ where: { id: i.id } });
    if (!g) throw new NotFoundError('Group');
    await ctx.perm.require('group:manage', g.courseId);
  },
  async handler(ctx, input) {
    const g = await ctx.tx.group.findUniqueOrThrow({ where: { id: input.id } });
    const dupe = await ctx.tx.group.findFirst({
      where: { courseId: g.courseId, name: input.name, id: { not: g.id } },
    });
    if (dupe) throw new ValidationError({ name: ['A group with this name already exists'] });
    await ctx.tx.group.update({
      where: { id: g.id },
      data: {
        name: input.name,
        description: input.description,
        enrolmentKey: input.enrolmentKey ?? null,
        idNumber: input.idNumber ?? null,
      },
    });
    return { id: g.id };
  },
});

export const deleteGroup = defineOperation({
  name: 'group.delete',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const g = await ctx.db.group.findUnique({ where: { id: i.id } });
    if (!g) throw new NotFoundError('Group');
    await ctx.perm.require('group:manage', g.courseId);
  },
  async handler(ctx, { id }) {
    const g = await ctx.tx.group.delete({ where: { id } });
    // restrictions to this group no longer lock anything
    await dropAvailabilityRefs(ctx.tx, g.courseId, namesGroups(new Set([id])));
    return { id };
  },
});

export const setGroupMembers = defineOperation({
  name: 'group.members',
  input: z.object({
    groupId: z.string().uuid(),
    add: z.array(z.string().uuid()).default([]),
    remove: z.array(z.string().uuid()).default([]),
  }),
  async authorize(ctx, i) {
    const g = await ctx.db.group.findUnique({ where: { id: i.groupId } });
    if (!g) throw new NotFoundError('Group');
    await ctx.perm.require('group:manage', g.courseId);
  },
  async handler(ctx, { groupId, add, remove }) {
    const g = await ctx.tx.group.findUniqueOrThrow({ where: { id: groupId } });
    if (add.length) {
      const enrolled = await ctx.tx.enrolment.findMany({
        where: { courseId: g.courseId, userId: { in: add } },
        select: { userId: true },
      });
      const ok = new Set(enrolled.map((e) => e.userId));
      const bad = add.filter((u) => !ok.has(u));
      if (bad.length)
        throw new ValidationError({ add: ['Only enrolled users can be added to a group'] });
      await ctx.tx.groupMember.createMany({
        data: add.map((userId) => ({ groupId, userId })),
        skipDuplicates: true,
      });
    }
    if (remove.length) {
      await ctx.tx.groupMember.deleteMany({ where: { groupId, userId: { in: remove } } });
      await leaveGroupChats(ctx.tx, { groupIds: [groupId] }, remove);
    }
    return { groupId };
  },
});

export async function listGroups(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('course:viewparticipants', courseId);
  const only = await separateGroupsOf(ctx, courseId);
  return ctx.db.group.findMany({
    where: { courseId, ...(only ? { id: { in: only } } : {}) },
    orderBy: { name: 'asc' },
    include: { members: { include: { user: { select: { id: true, name: true } } } } },
  });
}

/** The course's groups by name, as far as the user may see them (filters, pickers). */
export async function listGroupNames(ctx: RequestContext, courseId: string) {
  const only = await separateGroupsOf(ctx, courseId);
  return ctx.db.group.findMany({
    where: { courseId, ...(only ? { id: { in: only } } : {}) },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
}

// ── groupings (sets of groups an activity can be limited to) ─────────────────

const GroupingInput = z.object({
  courseId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(5000).default(''),
});

async function requireGroupingManager(ctx: RequestContext, id: string) {
  const g = await ctx.db.grouping.findUnique({ where: { id }, select: { courseId: true } });
  if (!g) throw new NotFoundError('Grouping');
  await ctx.perm.require('group:manage', g.courseId);
}

export const createGrouping = defineOperation({
  name: 'grouping.create',
  input: GroupingInput,
  authorize: (ctx, i) => ctx.perm.require('group:manage', i.courseId),
  async handler(ctx, input) {
    if (await ctx.tx.grouping.findFirst({ where: { courseId: input.courseId, name: input.name } }))
      throw new ValidationError({ name: ['A grouping with this name already exists'] });
    const g = await ctx.tx.grouping.create({ data: input });
    await logEvent(ctx.tx, {
      name: 'grouping.created',
      actorId: ctx.perm.userId,
      courseId: input.courseId,
      objectType: 'grouping',
      objectId: g.id,
      origin: ctx.origin,
    });
    return { id: g.id };
  },
});

export const updateGrouping = defineOperation({
  name: 'grouping.update',
  input: GroupingInput.omit({ courseId: true }).extend({ id: z.string().uuid() }),
  authorize: (ctx, i) => requireGroupingManager(ctx, i.id),
  async handler(ctx, input) {
    const g = await ctx.tx.grouping.findUniqueOrThrow({ where: { id: input.id } });
    const dupe = await ctx.tx.grouping.findFirst({
      where: { courseId: g.courseId, name: input.name, id: { not: g.id } },
    });
    if (dupe) throw new ValidationError({ name: ['A grouping with this name already exists'] });
    await ctx.tx.grouping.update({
      where: { id: g.id },
      data: { name: input.name, description: input.description },
    });
    return { id: g.id };
  },
});

export const deleteGrouping = defineOperation({
  name: 'grouping.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => requireGroupingManager(ctx, i.id),
  async handler(ctx, { id }) {
    // activities limited to it go back to all groups (Activity.groupingId is SET NULL)
    const g = await ctx.tx.grouping.delete({ where: { id } });
    await dropAvailabilityRefs(ctx.tx, g.courseId, namesGroupings(new Set([id])));
    return { id };
  },
});

/** Sets exactly which groups of the course belong to the grouping. */
export const setGroupingGroups = defineOperation({
  name: 'grouping.groups',
  input: z.object({
    groupingId: z.string().uuid(),
    groupIds: z.array(z.string().uuid()).max(1000),
  }),
  authorize: (ctx, i) => requireGroupingManager(ctx, i.groupingId),
  async handler(ctx, { groupingId, groupIds }) {
    const g = await ctx.tx.grouping.findUniqueOrThrow({ where: { id: groupingId } });
    const ok = await ctx.tx.group.count({ where: { id: { in: groupIds }, courseId: g.courseId } });
    if (ok !== new Set(groupIds).size)
      throw new ValidationError({ groupIds: ['Groups must belong to the same course'] });
    await ctx.tx.groupingGroup.deleteMany({
      where: { groupingId, groupId: { notIn: groupIds } },
    });
    await ctx.tx.groupingGroup.createMany({
      data: groupIds.map((groupId) => ({ groupingId, groupId })),
      skipDuplicates: true,
    });
    return { groupingId };
  },
});

export async function listGroupings(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('course:viewparticipants', courseId);
  return ctx.db.grouping.findMany({
    where: { courseId },
    orderBy: { name: 'asc' },
    include: { groups: { select: { groupId: true } }, _count: { select: { activities: true } } },
  });
}

// ── cohorts (site-wide groups) ────────────────────────────────────────────────

const CohortInput = z.object({
  name: z.string().trim().min(1).max(255),
  idNumber: optionalText(100),
  description: z.string().max(5000).default(''),
});

export const createCohort = defineOperation({
  name: 'cohort.create',
  input: CohortInput,
  authorize: (ctx) => ctx.perm.require('cohort:manage'),
  async handler(ctx, input) {
    if (
      input.idNumber &&
      (await ctx.tx.cohort.findUnique({ where: { idNumber: input.idNumber } }))
    ) {
      throw new ValidationError({ idNumber: ['ID number already in use'] });
    }
    const c = await ctx.tx.cohort.create({
      data: { ...input, idNumber: input.idNumber ?? null, contextId: SYSTEM_CONTEXT_ID },
    });
    return { id: c.id };
  },
});

export const deleteCohort = defineOperation({
  name: 'cohort.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('cohort:manage'),
  async handler(ctx, { id }) {
    // Courses synced with the cohort lose those enrolments, as if each sync were removed.
    const methods = await ctx.tx.enrolmentMethod.findMany({
      where: { cohortId: id, type: 'COHORT' },
    });
    for (const m of methods) await deleteMethod(ctx, m.id);
    await ctx.tx.cohort.delete({ where: { id } });
    return { id };
  },
});

/** Removes an enrolment method with its enrolments and the roles they granted. */
async function deleteMethod(
  ctx: RequestContext & { tx: Prisma.TransactionClient },
  methodId: string,
) {
  const method = await ctx.tx.enrolmentMethod.findUniqueOrThrow({ where: { id: methodId } });
  const ens = await ctx.tx.enrolment.findMany({ where: { methodId } });
  await ctx.tx.roleAssignment.deleteMany({
    where: { enrolmentId: { in: ens.map((e) => e.id) } },
  });
  await ctx.tx.enrolmentMethod.delete({ where: { id: methodId } });
  await leaveCourseIfUnenrolled(
    ctx,
    method.courseId,
    ens.map((e) => e.userId),
  );
}

async function leaveCourseIfUnenrolled(
  ctx: RequestContext & { tx: Prisma.TransactionClient },
  courseId: string,
  userIds: string[],
) {
  if (!userIds.length) return;
  const still = new Set(
    (
      await ctx.tx.enrolment.findMany({
        where: { courseId, userId: { in: userIds } },
        select: { userId: true },
      })
    ).map((e) => e.userId),
  );
  for (const u of userIds)
    if (!still.has(u)) await removeCourseMembership(ctx, ctx.tx, courseId, u);
}

/** Adds/removes cohort members and keeps cohort-synced course enrolments in step. */
export const setCohortMembers = defineOperation({
  name: 'cohort.members',
  input: z.object({
    cohortId: z.string().uuid(),
    add: z.array(z.string().uuid()).default([]),
    remove: z.array(z.string().uuid()).default([]),
  }),
  authorize: (ctx) => ctx.perm.require('cohort:manage'),
  async handler(ctx, { cohortId, add, remove }) {
    if (add.length)
      await ctx.tx.cohortMember.createMany({
        data: add.map((userId) => ({ cohortId, userId })),
        skipDuplicates: true,
      });
    if (remove.length)
      await ctx.tx.cohortMember.deleteMany({ where: { cohortId, userId: { in: remove } } });
    const methods = await ctx.tx.enrolmentMethod.findMany({
      where: { cohortId, type: 'COHORT', enabled: true },
    });
    for (const m of methods) {
      for (const userId of add) {
        await enrolUserRecord(ctx.tx, {
          courseId: m.courseId,
          methodId: m.id,
          userId,
          roleId: m.roleId,
          component: 'COHORT',
        });
      }
      if (remove.length) {
        const ens = await ctx.tx.enrolment.findMany({
          where: { methodId: m.id, userId: { in: remove } },
        });
        await ctx.tx.roleAssignment.deleteMany({
          where: { enrolmentId: { in: ens.map((e) => e.id) } },
        });
        await ctx.tx.enrolment.deleteMany({ where: { id: { in: ens.map((e) => e.id) } } });
        await leaveCourseIfUnenrolled(
          ctx,
          m.courseId,
          ens.map((e) => e.userId),
        );
      }
    }
    return { cohortId };
  },
});

/** Links a cohort to a course: every member is enrolled and stays in sync. */
export const addCohortSync = defineOperation({
  name: 'enrol.cohort.add',
  input: z.object({
    courseId: z.string().uuid(),
    cohortId: z.string().uuid(),
    roleId: z.string().uuid(),
  }),
  authorize: (ctx, i) => ctx.perm.require('enrol:manage', i.courseId),
  async handler(ctx, { courseId, cohortId, roleId }) {
    await assertCourseRole(ctx, courseId, roleId);
    const cohort = await ctx.tx.cohort.findUnique({
      where: { id: cohortId },
      include: { members: true },
    });
    if (!cohort) throw new NotFoundError('Cohort');
    if (await ctx.tx.enrolmentMethod.findFirst({ where: { courseId, cohortId, type: 'COHORT' } }))
      throw new ConflictError('This cohort is already synced with the course');
    const method = await ctx.tx.enrolmentMethod.create({
      data: { courseId, type: 'COHORT', cohortId, roleId, name: cohort.name, sortOrder: 5 },
    });
    for (const m of cohort.members) {
      await enrolUserRecord(ctx.tx, {
        courseId,
        methodId: method.id,
        userId: m.userId,
        roleId,
        component: 'COHORT',
      });
    }
    return { methodId: method.id, enrolled: cohort.members.length };
  },
});

export const removeEnrolmentMethod = defineOperation({
  name: 'enrol.method.remove',
  input: z.object({ methodId: z.string().uuid() }),
  async authorize(ctx, i) {
    const m = await ctx.db.enrolmentMethod.findUnique({ where: { id: i.methodId } });
    if (!m) throw new NotFoundError('Enrolment method');
    await ctx.perm.require('enrol:manage', m.courseId);
    if (m.type === 'MANUAL')
      throw new ValidationError({ methodId: ['The manual method cannot be removed'] });
  },
  async handler(ctx, { methodId }) {
    await deleteMethod(ctx, methodId);
    return { methodId };
  },
});
