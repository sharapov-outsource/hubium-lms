import type { AutoLink } from '@hubium/module-sdk';
import type { RequestContext } from '../context.ts';
import { getActivityAccess } from '../courses/activities.ts';
import { isModuleEnabled } from '../settings/modules.ts';
import { getAllSettings } from '../settings/settings.ts';
import { buildModuleCtx, toActivityRef } from './module-ctx.ts';
import { getModule, listModules } from './registry.ts';

/**
 * Words the course's texts link to activity pages (glossary auto-linking): asked of the
 * activities whose modules link words, are turned on, and that the viewer may open.
 */
export async function courseAutoLinks(ctx: RequestContext, courseId: string): Promise<AutoLink[]> {
  const settings = await getAllSettings(ctx.db);
  const keys = listModules()
    .filter((m) => m.autoLinks && isModuleEnabled(settings, m.key))
    .map((m) => m.key);
  if (!keys.length) return [];
  const activities = await ctx.db.activity.findMany({
    where: { courseId, deletedAt: null, moduleKey: { in: keys } },
  });
  const out: AutoLink[] = [];
  for (const a of activities) {
    const access = await getActivityAccess(ctx, a.id).catch(() => null);
    if (!access?.canOpen) continue;
    const m = getModule(a.moduleKey)!;
    out.push(...(await m.autoLinks!(buildModuleCtx(ctx), toActivityRef(a) as never)));
  }
  return out;
}
