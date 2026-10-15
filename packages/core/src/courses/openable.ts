import { loadUserAccess, Permissions } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';
import { provideModuleServices } from '../modules/module-ctx.ts';
import { isModuleEnabled } from '../settings/modules.ts';
import { getAllSettings } from '../settings/settings.ts';
import { getActivityAccess } from './activities.ts';

const restricted = (v: unknown) => v !== null && v !== undefined;

/**
 * Those of `userIds` who may open the activity now: notifications and reminders about it
 * go to them only, or a hidden activity or one restricted to some would show its name and
 * text to everyone. An activity everyone in the course sees (shown or stealth, without
 * restrictions, in a visible section of a visible course) needs no check per person.
 */
export async function usersWhoCanOpen(
  ctx: RequestContext,
  activityId: string,
  userIds: string[],
): Promise<string[]> {
  if (!userIds.length) return [];
  const a = await ctx.db.activity.findUnique({
    where: { id: activityId },
    select: {
      deletedAt: true,
      visibility: true,
      availability: true,
      moduleKey: true,
      course: { select: { visible: true, deletedAt: true } },
      section: {
        select: {
          visible: true,
          availability: true,
          parent: { select: { visible: true, availability: true } },
        },
      },
    },
  });
  if (!a || a.deletedAt || a.course.deletedAt) return [];
  if (!isModuleEnabled(await getAllSettings(ctx.db), a.moduleKey)) return [];
  const sections = [a.section, a.section?.parent].filter((s) => !!s);
  const open =
    a.visibility !== 'HIDDEN' &&
    !restricted(a.availability) &&
    a.course.visible &&
    sections.every((s) => s.visible && !restricted(s.availability));
  if (open) return userIds;
  const users = await ctx.db.user.findMany({
    where: { id: { in: userIds }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, isSiteAdmin: true },
  });
  const out: string[] = [];
  for (const u of users) {
    const as: RequestContext = {
      ...ctx,
      actor: { kind: 'user', userId: u.id, isSiteAdmin: u.isSiteAdmin },
      perm: new Permissions(ctx.db, await loadUserAccess(ctx.db, u)),
    };
    if ((await getActivityAccess(as, activityId).catch(() => null))?.canOpen) out.push(u.id);
  }
  return out;
}

provideModuleServices({
  openableBy: (ctx, tx) => (activityId, userIds) =>
    usersWhoCanOpen({ ...ctx, db: tx as never }, activityId, userIds),
});
