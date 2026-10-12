import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { enrolUserRecord } from '../enrol/enrol.ts';
import { NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { optionalText } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';

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
    await ctx.tx.group.delete({ where: { id } });
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
    if (remove.length)
      await ctx.tx.groupMember.deleteMany({ where: { groupId, userId: { in: remove } } });
    return { groupId };
  },
});

export async function listGroups(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('course:viewparticipants', courseId);
  return ctx.db.group.findMany({
    where: { courseId },
    orderBy: { name: 'asc' },
    include: { members: { include: { user: { select: { id: true, name: true } } } } },
  });
}

/** Groups the user belongs to in the course; null when they can see all groups. */
export async function visibleGroupIds(
  ctx: RequestContext,
  courseId: string,
): Promise<string[] | null> {
  if (await ctx.perm.can('group:accessall', courseId)) return null;
  const rows = await ctx.db.groupMember.findMany({
    where: { userId: ctx.perm.userId ?? '', group: { courseId } },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
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
    await ctx.tx.cohort.delete({ where: { id } });
    return { id };
  },
});

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
    const cohort = await ctx.tx.cohort.findUnique({
      where: { id: cohortId },
      include: { members: true },
    });
    if (!cohort) throw new NotFoundError('Cohort');
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
    const ens = await ctx.tx.enrolment.findMany({ where: { methodId } });
    await ctx.tx.roleAssignment.deleteMany({
      where: { enrolmentId: { in: ens.map((e) => e.id) } },
    });
    await ctx.tx.enrolmentMethod.delete({ where: { id: methodId } });
    return { methodId };
  },
});
