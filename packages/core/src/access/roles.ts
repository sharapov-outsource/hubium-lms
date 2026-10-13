import type { ContextLevel, Db, Prisma, RoleArchetype } from '@hubium/db';
import { locales } from '@hubium/i18n';
import { createTranslator } from '@hubium/i18n/packs';
import { type Localized, pickLocalized } from '../lib/localized.ts';
import { capabilities, defaultCapabilitiesFor } from './capabilities.ts';

export interface DefaultRole {
  shortName: string;
  archetype: RoleArchetype;
  assignableLevels: ContextLevel[];
  /** Implicit roles are never assigned by hand. */
  implicit?: boolean;
}

export const defaultRoles: DefaultRole[] = [
  {
    shortName: 'manager',
    archetype: 'MANAGER',
    assignableLevels: ['SYSTEM', 'CATEGORY', 'COURSE'],
  },
  {
    shortName: 'coursecreator',
    archetype: 'COURSECREATOR',
    assignableLevels: ['SYSTEM', 'CATEGORY'],
  },
  {
    shortName: 'editingteacher',
    archetype: 'EDITINGTEACHER',
    assignableLevels: ['COURSE', 'ACTIVITY'],
  },
  {
    shortName: 'teacher',
    archetype: 'TEACHER',
    assignableLevels: ['COURSE', 'ACTIVITY'],
  },
  {
    shortName: 'student',
    archetype: 'STUDENT',
    assignableLevels: ['COURSE', 'ACTIVITY'],
  },
  {
    shortName: 'observer',
    archetype: 'OBSERVER',
    assignableLevels: ['COURSE'],
  },
  {
    shortName: 'guest',
    archetype: 'GUEST',
    assignableLevels: [],
    implicit: true,
  },
  {
    shortName: 'user',
    archetype: 'USER',
    assignableLevels: [],
    implicit: true,
  },
];

/** Which roles each role may assign (Moodle's "allow role assignments"). */
const defaultAssignRules: Record<string, string[]> = {
  manager: ['manager', 'coursecreator', 'editingteacher', 'teacher', 'student', 'observer'],
  editingteacher: ['teacher', 'student', 'observer'],
};

const SYNCED_KEY = 'access.syncedCapabilities';

/** A built-in role's name in every installed language (the archetype names of the packs). */
export function defaultRoleName(archetype: RoleArchetype): Localized {
  return Object.fromEntries(
    locales.map((l) => [l, createTranslator(l)(`admin.role.archetypes.${archetype}`)]),
  );
}

/** A role's name for display: its name in `locale`, another language, or its short name. */
export function roleName(role: { name: unknown; shortName: string }, locale: string): string {
  return pickLocalized(role.name, locale) || role.shortName;
}

/**
 * Creates missing default roles and grants newly introduced capabilities to roles
 * by archetype. Capabilities seen before are never touched, so admin edits survive.
 */
export async function syncCapabilities(db: Db): Promise<{ newCapabilities: string[] }> {
  return db.$transaction(async (tx) => {
    const existing = await tx.role.findMany({
      select: { id: true, shortName: true, archetype: true, name: true },
    });
    const byShort = new Map(existing.map((r) => [r.shortName, r]));
    const created: string[] = [];

    for (const [i, def] of defaultRoles.entries()) {
      const found = byShort.get(def.shortName);
      if (found) {
        // languages installed since: their names are added, names set by hand stay
        const name = { ...defaultRoleName(def.archetype), ...(found.name as Localized) };
        if (Object.keys(name).length > Object.keys(found.name as object).length)
          await tx.role.update({ where: { id: found.id }, data: { name } });
        continue;
      }
      const role = await tx.role.create({
        data: {
          shortName: def.shortName,
          archetype: def.archetype,
          name: defaultRoleName(def.archetype) as Prisma.InputJsonValue,
          assignableLevels: def.assignableLevels,
          sortOrder: i,
          isProtected: def.implicit ?? false,
        },
      });
      byShort.set(def.shortName, role);
      created.push(role.id);
      const caps = defaultCapabilitiesFor(def.archetype);
      if (caps.length) {
        await tx.roleCapability.createMany({
          data: caps.map((capability) => ({
            roleId: role.id,
            capability,
            permission: 'ALLOW' as const,
          })),
        });
      }
    }

    for (const [assigner, targets] of Object.entries(defaultAssignRules)) {
      const from = byShort.get(assigner);
      if (!from || !created.includes(from.id)) continue;
      await tx.roleAssignRule.createMany({
        data: targets
          .map((t) => byShort.get(t))
          .filter((r) => r !== undefined)
          .map((r) => ({ roleId: from.id, assignableRoleId: r.id })),
        skipDuplicates: true,
      });
    }

    const syncedRow = await tx.siteSetting.findUnique({ where: { key: SYNCED_KEY } });
    const synced = new Set<string>(
      Array.isArray(syncedRow?.value) ? (syncedRow.value as string[]) : [],
    );
    const newCaps = [...capabilities.keys()].filter((c) => !synced.has(c));

    if (syncedRow) {
      // Roles created above already got full defaults; older roles get only new caps.
      const older = [...byShort.values()].filter((r) => !created.includes(r.id));
      const rows = older.flatMap((r) =>
        newCaps
          .filter((c) => capabilities.get(c)!.archetypes.includes(r.archetype))
          .map((capability) => ({ roleId: r.id, capability, permission: 'ALLOW' as const })),
      );
      if (rows.length) await tx.roleCapability.createMany({ data: rows, skipDuplicates: true });
    }

    await tx.siteSetting.upsert({
      where: { key: SYNCED_KEY },
      create: { key: SYNCED_KEY, value: [...capabilities.keys()] },
      update: { value: [...new Set([...synced, ...capabilities.keys()])] },
    });
    // Running web instances cache role definitions; tell them to reload (sent on commit).
    if (created.length || newCaps.length)
      await tx.$executeRaw`SELECT pg_notify('hubium_cache', 'roles')`;
    return { newCapabilities: syncedRow ? newCaps : [] };
  });
}

/** Archetypes a teacher may preview the course as ("view as role"). Never more powerful ones. */
export const SWITCHABLE_ARCHETYPES = ['TEACHER', 'STUDENT', 'OBSERVER', 'GUEST'] as const;

/** Validates a "view as" request: a course context and a role with a harmless archetype. */
export async function isSwitchableRole(
  db: Db,
  contextId: string,
  roleId: string,
): Promise<boolean> {
  const [role, ctx] = await Promise.all([
    db.role.findUnique({ where: { id: roleId }, select: { archetype: true } }),
    db.context.findUnique({ where: { id: contextId }, select: { level: true } }),
  ]);
  return (
    !!role &&
    ctx?.level === 'COURSE' &&
    (SWITCHABLE_ARCHETYPES as readonly string[]).includes(role.archetype)
  );
}
