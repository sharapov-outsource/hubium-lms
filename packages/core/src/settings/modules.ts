import type { Db } from '@hubium/db';
import { type ActivityModule, type Msg, msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { getModule, listModules } from '../modules/registry.ts';
import { defineOperation } from '../operation.ts';
import { type AllSettings, getAllSettings, setSettings } from './settings.ts';

// Administration → Modules: which activity types teachers can add and learners can open.
// Turning a type off changes no data: its activities stay in courses and the gradebook,
// hidden from learners and greyed out for editors, until it is turned on again.

/** Types the importers fall back to for unknown activities, so they cannot be turned off. */
export const REQUIRED_MODULES: readonly string[] = ['page', 'url', 'label', 'file'];

/** In this build and not turned off by the administrator. */
export function isModuleEnabled(s: AllSettings, key: string): boolean {
  if (!getModule(key)) return false;
  return REQUIRED_MODULES.includes(key) || !s['modules.disabled'].includes(key);
}

export async function enabledModules(db: Db): Promise<ActivityModule<unknown>[]> {
  const s = await getAllSettings(db);
  return listModules().filter((m) => isModuleEnabled(s, m.key));
}

export async function assertModuleEnabled(db: Db, key: string): Promise<void> {
  if (!isModuleEnabled(await getAllSettings(db), key))
    throw new ForbiddenError(msg('errors.common.moduleDisabled'));
}

export interface ModuleRow {
  key: string;
  icon: string;
  archetype: ActivityModule<unknown>['archetype'];
  enabled: boolean;
  required: boolean;
  /** Activities of this type, outside the recycle bin. */
  activities: number;
  courses: number;
  /** Of them, activities that count towards completion. */
  tracked: number;
}

export async function moduleOverview(ctx: RequestContext): Promise<ModuleRow[]> {
  await ctx.perm.require('site:config');
  const settings = await getAllSettings(ctx.db);
  const counts = await ctx.db.$queryRaw<
    { moduleKey: string; activities: number; courses: number; tracked: number }[]
  >`
    SELECT "moduleKey",
           count(*)::int AS activities,
           count(DISTINCT "courseId")::int AS courses,
           (count(*) FILTER (WHERE "completionMode" <> 'NONE'))::int AS tracked
      FROM "Activity" WHERE "deletedAt" IS NULL GROUP BY "moduleKey"`;
  const of = new Map(counts.map((c) => [c.moduleKey, c]));
  return listModules().map((m) => ({
    key: m.key,
    icon: m.icon,
    archetype: m.archetype,
    enabled: isModuleEnabled(settings, m.key),
    required: REQUIRED_MODULES.includes(m.key),
    activities: of.get(m.key)?.activities ?? 0,
    courses: of.get(m.key)?.courses ?? 0,
    tracked: of.get(m.key)?.tracked ?? 0,
  }));
}

export const saveModuleSettings = defineOperation({
  name: 'site.modules',
  offline: 'online',
  input: z.object({ enabled: z.array(z.string().min(1).max(50)) }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, input) {
    const unknown = input.enabled.filter((k) => !getModule(k));
    if (unknown.length)
      throw new ValidationError({
        enabled: [msg('errors.settings.unknownActivityTypes', { unknown: unknown.join(', ') })],
      });
    const current = await getAllSettings(ctx.db);
    // Types missing from this build keep their state for a build that has them again.
    const absent = current['modules.disabled'].filter((k) => !getModule(k));
    const disabled = [
      ...listModules()
        .map((m) => m.key)
        .filter((k) => !REQUIRED_MODULES.includes(k) && !input.enabled.includes(k)),
      ...absent,
    ].sort();
    await setSettings(ctx.tx, { 'modules.disabled': disabled }, ctx.perm.userId ?? undefined);
    await logEvent(ctx.tx, {
      name: 'site.modules.updated',
      actorId: ctx.perm.userId,
      data: { disabled },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { disabled };
  },
});

/** Types of a course's activities that are turned off, for import and restore reports. */
export async function disabledTypesIn(db: Db, courseId: string): Promise<string[]> {
  const s = await getAllSettings(db);
  const rows = await db.activity.findMany({
    where: { courseId, deletedAt: null },
    distinct: ['moduleKey'],
    select: { moduleKey: true },
  });
  return rows.map((r) => r.moduleKey).filter((k) => !isModuleEnabled(s, k));
}

/** What an import says about the activities it kept whose types are turned off. */
export function disabledTypesWarning(keys: string[]): Msg[] {
  return keys.length ? [msg('errors.import.disabledTypes', { types: keys.join(', ') })] : [];
}
