import type { Prisma } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { localizedText } from '../lib/localized.ts';
import { defineOperation } from '../operation.ts';
import { getSetting } from '../settings/settings.ts';
import { type Capability, capabilities, isCapability, type Level } from './capabilities.ts';
import { invalidatePermissionCaches } from './permissions.ts';

async function notifyRoles(tx: Prisma.TransactionClient): Promise<void> {
  invalidatePermissionCaches('roles');
  await tx.$executeRaw`SELECT pg_notify('hubium_cache', 'roles')`;
}

// Role editor operations (capability matrix) and context overrides.

const LocalisedName = localizedText(100);

export const createRole = defineOperation({
  name: 'role.create',
  input: z.object({
    shortName: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,49}$/),
    name: LocalisedName,
    archetype: z.enum([
      'MANAGER',
      'COURSECREATOR',
      'EDITINGTEACHER',
      'TEACHER',
      'STUDENT',
      'OBSERVER',
      'NONE',
    ]),
    assignableLevels: z.array(z.enum(['SYSTEM', 'CATEGORY', 'COURSE', 'ACTIVITY'])).default([]),
    copyFromRoleId: z.string().uuid().optional(),
  }),
  authorize: (ctx) => ctx.perm.require('role:manage'),
  async handler(ctx, input) {
    if (await ctx.tx.role.findUnique({ where: { shortName: input.shortName } })) {
      throw new ValidationError({ shortName: [msg('errors.common.shortNameInUse')] });
    }
    const count = await ctx.tx.role.count();
    const role = await ctx.tx.role.create({
      data: {
        shortName: input.shortName,
        name: input.name,
        archetype: input.archetype,
        assignableLevels: input.assignableLevels,
        sortOrder: count,
      },
    });
    if (input.copyFromRoleId) {
      const caps = await ctx.tx.roleCapability.findMany({
        where: { roleId: input.copyFromRoleId },
      });
      if (caps.length) {
        await ctx.tx.roleCapability.createMany({
          data: caps.map((c) => ({
            roleId: role.id,
            capability: c.capability,
            permission: c.permission,
          })),
        });
      }
    }
    await logEvent(ctx.tx, {
      name: 'role.created',
      actorId: ctx.perm.userId,
      objectType: 'role',
      objectId: role.id,
      origin: ctx.origin,
    });
    await notifyRoles(ctx.tx);
    return { id: role.id };
  },
});

export const updateRole = defineOperation({
  name: 'role.update',
  input: z.object({
    id: z.string().uuid(),
    name: LocalisedName,
    assignableLevels: z.array(z.enum(['SYSTEM', 'CATEGORY', 'COURSE', 'ACTIVITY'])),
  }),
  authorize: (ctx) => ctx.perm.require('role:manage'),
  async handler(ctx, input) {
    const role = await ctx.tx.role.findUnique({ where: { id: input.id } });
    if (!role) throw new NotFoundError('Role');
    if (
      !input.assignableLevels.includes('COURSE') &&
      role.shortName === (await getSetting(ctx.tx, 'course.creatorRole'))
    )
      throw new ValidationError({
        assignableLevels: [msg('errors.access.creatorRole')],
      });
    await ctx.tx.role.update({
      where: { id: role.id },
      data: { name: input.name, assignableLevels: role.isProtected ? [] : input.assignableLevels },
    });
    await logEvent(ctx.tx, {
      name: 'role.updated',
      actorId: ctx.perm.userId,
      objectType: 'role',
      objectId: role.id,
      data: { assignableLevels: role.isProtected ? [] : input.assignableLevels },
      origin: ctx.origin,
    });
    await notifyRoles(ctx.tx);
    return { id: role.id };
  },
});

export const deleteRole = defineOperation({
  name: 'role.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('role:manage'),
  async handler(ctx, { id }) {
    const role = await ctx.tx.role.findUnique({
      where: { id },
      include: { _count: { select: { assignments: true, enrolMethods: true } } },
    });
    if (!role) throw new NotFoundError('Role');
    if (role.isProtected) throw new ConflictError(msg('errors.access.builtInRole'));
    if (role._count.assignments || role._count.enrolMethods) {
      throw new ConflictError(msg('errors.access.roleInUse'));
    }
    if (role.shortName === (await getSetting(ctx.tx, 'course.creatorRole')))
      throw new ConflictError(msg('errors.access.creatorRoleChange'));
    await ctx.tx.role.delete({ where: { id } });
    await logEvent(ctx.tx, {
      name: 'role.deleted',
      actorId: ctx.perm.userId,
      objectType: 'role',
      objectId: id,
      data: { shortName: role.shortName },
      origin: ctx.origin,
    });
    await notifyRoles(ctx.tx);
    return { id };
  },
});

export const setRoleCapability = defineOperation({
  name: 'role.setCapability',
  input: z.object({
    roleId: z.string().uuid(),
    capability: z.string().refine(isCapability, 'Unknown capability'),
    permission: z.enum(['ALLOW', 'PROHIBIT', 'INHERIT']),
  }),
  authorize: (ctx) => ctx.perm.require('role:manage'),
  async handler(ctx, { roleId, capability, permission }) {
    if (permission === 'INHERIT') {
      await ctx.tx.roleCapability.deleteMany({ where: { roleId, capability } });
    } else {
      await ctx.tx.roleCapability.upsert({
        where: { roleId_capability: { roleId, capability } },
        create: { roleId, capability, permission },
        update: { permission },
      });
    }
    await logEvent(ctx.tx, {
      name: 'role.capability.changed',
      actorId: ctx.perm.userId,
      objectType: 'role',
      objectId: roleId,
      data: { capability, permission },
      origin: ctx.origin,
    });
    await notifyRoles(ctx.tx);
    return { ok: true };
  },
});

const LEVEL_DEPTH: Record<Level, number> = { SYSTEM: 0, CATEGORY: 1, COURSE: 2, ACTIVITY: 3 };

/**
 * Capabilities a context of `level` can override: those that apply at that level or below.
 * An activity gets the generic activity capabilities and those of its own module.
 */
export function overridableCapabilities(level: Level, moduleKey?: string | null): Capability[] {
  const out: Capability[] = [];
  for (const [cap, def] of capabilities) {
    if (LEVEL_DEPTH[def.level] < LEVEL_DEPTH[level]) continue;
    if (level === 'ACTIVITY' && cap.startsWith('mod.') && !cap.startsWith(`mod.${moduleKey}:`))
      continue;
    out.push(cap);
  }
  return out;
}

/** Level of a context and, for an activity, its module. */
export async function overrideScope(db: Prisma.TransactionClient, contextId: string) {
  const c = await db.context.findUnique({
    where: { id: contextId },
    select: { level: true, activity: { select: { moduleKey: true, courseId: true } } },
  });
  if (!c) throw new NotFoundError('Context');
  return {
    level: c.level as Level,
    moduleKey: c.activity?.moduleKey ?? null,
    courseId: c.level === 'COURSE' ? contextId : (c.activity?.courseId ?? null),
  };
}

/** Overrides set directly in one context (for the "Permissions" pages). */
export const listRoleOverrides = defineOperation({
  name: 'role.listOverrides',
  input: z.object({ contextId: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('role:review', i.contextId),
  mutation: false,
  async handler(ctx, { contextId }) {
    const scope = await overrideScope(ctx.tx, contextId);
    const overrides = await ctx.tx.roleOverride.findMany({
      where: { contextId },
      select: { roleId: true, capability: true, permission: true },
    });
    return {
      ...scope,
      capabilities: overridableCapabilities(scope.level, scope.moduleKey),
      overrides,
    };
  },
});

export const setRoleOverride = defineOperation({
  name: 'role.setOverride',
  input: z.object({
    contextId: z.string().uuid(),
    roleId: z.string().uuid(),
    capability: z.string().refine(isCapability, 'Unknown capability'),
    permission: z.enum(['ALLOW', 'DENY', 'PROHIBIT', 'INHERIT']),
  }),
  authorize: (ctx, i) => ctx.perm.require('role:override', i.contextId),
  async handler(ctx, { contextId, roleId, capability, permission }) {
    const scope = await overrideScope(ctx.tx, contextId);
    if (!overridableCapabilities(scope.level, scope.moduleKey).includes(capability as Capability))
      throw new ValidationError({ capability: [msg('errors.access.permissionFixed')] });
    // As in Moodle: nobody grants others more than they have themselves.
    if (
      permission === 'ALLOW' &&
      !ctx.perm.isSiteAdmin &&
      !(await ctx.perm.can(capability as Capability, contextId))
    )
      throw new ForbiddenError(msg('errors.access.ownPermissionsOnly'));
    if (!(await ctx.tx.role.findUnique({ where: { id: roleId }, select: { id: true } })))
      throw new NotFoundError('Role');
    if (permission === 'INHERIT') {
      await ctx.tx.roleOverride.deleteMany({ where: { contextId, roleId, capability } });
    } else {
      await ctx.tx.roleOverride.upsert({
        where: { contextId_roleId_capability: { contextId, roleId, capability } },
        create: { contextId, roleId, capability, permission },
        update: { permission },
      });
    }
    await logEvent(ctx.tx, {
      name: 'role.override.changed',
      actorId: ctx.perm.userId,
      contextId,
      courseId: scope.courseId,
      objectType: 'role',
      objectId: roleId,
      data: { capability, permission },
      origin: ctx.origin,
    });
    await notifyRoles(ctx.tx);
    return { ok: true };
  },
});
