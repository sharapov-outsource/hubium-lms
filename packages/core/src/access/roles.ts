import type { ContextLevel, Db, RoleArchetype } from '@hubium/db';
import { capabilities, defaultCapabilitiesFor } from './capabilities.ts';

export interface DefaultRole {
  shortName: string;
  archetype: RoleArchetype;
  name: { ru: string; en: string };
  assignableLevels: ContextLevel[];
  /** Implicit roles are never assigned by hand. */
  implicit?: boolean;
}

export const defaultRoles: DefaultRole[] = [
  {
    shortName: 'manager',
    archetype: 'MANAGER',
    name: { ru: 'Менеджер', en: 'Manager' },
    assignableLevels: ['SYSTEM', 'CATEGORY', 'COURSE'],
  },
  {
    shortName: 'coursecreator',
    archetype: 'COURSECREATOR',
    name: { ru: 'Создатель курсов', en: 'Course creator' },
    assignableLevels: ['SYSTEM', 'CATEGORY'],
  },
  {
    shortName: 'editingteacher',
    archetype: 'EDITINGTEACHER',
    name: { ru: 'Преподаватель', en: 'Teacher' },
    assignableLevels: ['COURSE', 'ACTIVITY'],
  },
  {
    shortName: 'teacher',
    archetype: 'TEACHER',
    name: { ru: 'Ассистент', en: 'Non-editing teacher' },
    assignableLevels: ['COURSE', 'ACTIVITY'],
  },
  {
    shortName: 'student',
    archetype: 'STUDENT',
    name: { ru: 'Студент', en: 'Student' },
    assignableLevels: ['COURSE', 'ACTIVITY'],
  },
  {
    shortName: 'observer',
    archetype: 'OBSERVER',
    name: { ru: 'Наблюдатель', en: 'Observer' },
    assignableLevels: ['COURSE'],
  },
  {
    shortName: 'guest',
    archetype: 'GUEST',
    name: { ru: 'Гость', en: 'Guest' },
    assignableLevels: [],
    implicit: true,
  },
  {
    shortName: 'user',
    archetype: 'USER',
    name: { ru: 'Пользователь', en: 'Authenticated user' },
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

/**
 * Creates missing default roles and grants newly introduced capabilities to roles
 * by archetype. Capabilities seen before are never touched, so admin edits survive.
 */
export async function syncCapabilities(db: Db): Promise<{ newCapabilities: string[] }> {
  return db.$transaction(async (tx) => {
    const existing = await tx.role.findMany({
      select: { id: true, shortName: true, archetype: true },
    });
    const byShort = new Map(existing.map((r) => [r.shortName, r]));
    const created: string[] = [];

    for (const [i, def] of defaultRoles.entries()) {
      if (byShort.has(def.shortName)) continue;
      const role = await tx.role.create({
        data: {
          shortName: def.shortName,
          archetype: def.archetype,
          name: def.name,
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
    return { newCapabilities: syncedRow ? newCaps : [] };
  });
}
