import type { RequestContext } from '../context.ts';
import { registerFileArea, registerFileComponentPrefix } from '../files/files.ts';
import { buildModuleCtx, provideModuleServices, toActivityRef } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { getActivityAccess } from './activities.ts';
import { getCourseAccess } from './courses.ts';

// File read rules for course-level areas and activity modules.

// Course cover images appear in the public catalog.
registerFileArea('course', 'image', async () => true);

// A course's backups (made in the background, see @hubium/interchange): those who may back
// the course up.
registerFileArea('backup', 'course', (ctx, file) => ctx.perm.can('backup:create', file.contextId));

// Images embedded in course/activity rich text: anyone who can view the course.
registerFileArea('course', 'editor', async (ctx, file) => {
  const course = await ctx.db.course.findUnique({
    where: { id: file.contextId },
    select: { id: true },
  });
  if (!course) return false;
  return (await getCourseAccess(ctx, course.id)).canView;
});

/** How long a person's access to an activity is remembered for its files and routes. */
const ACCESS_MEMORY_MS = process.env.VITEST ? 0 : 10_000;
const MAX_REMEMBERED = 10_000;
const remembered = new Map<string, { until: number; canManage: boolean }>();

/**
 * Whether the person may open the activity (and manage it), for the files and HTTP routes of
 * activities, which come in bursts: a page's pictures, a video's segments every few seconds.
 * getActivityAccess builds the course's whole outline with its restrictions and completion,
 * so a yes is kept for ten seconds (access taken away reaches these requests that much
 * later; pages still ask each time). The activity itself is read afresh every time.
 */
async function recentActivityAccess(ctx: RequestContext, activityId: string) {
  const a = ctx.perm.access;
  const key =
    ACCESS_MEMORY_MS && (a.kind === 'user' || a.kind === 'token')
      ? JSON.stringify([a.kind, a.userId, a.scopes, a.switchedRole, activityId])
      : null;
  const now = Date.now();
  const hit = key ? remembered.get(key) : undefined;
  if (hit && hit.until > now) {
    const activity = await ctx.db.activity.findUnique({ where: { id: activityId } });
    if (activity && !activity.deletedAt)
      return { activity, canOpen: true, canManage: hit.canManage };
  }
  const r = await getActivityAccess(ctx, activityId).catch(() => null);
  if (!r) return null;
  const canManage = r.access.canManageActivities;
  if (key) {
    remembered.delete(key);
    // only a yes is kept: what opens later (a restriction met) opens at once
    if (r.canOpen) remembered.set(key, { until: now + ACCESS_MEMORY_MS, canManage });
    // the oldest go first (a Map keeps the order things were put in)
    for (const [k, v] of remembered) {
      if (remembered.size <= MAX_REMEMBERED && v.until > now) break;
      remembered.delete(k);
    }
  }
  return { activity: r.activity, canOpen: r.canOpen, canManage };
}

// Activity module areas: the viewer must be able to open the activity; managers always can;
// otherwise the module's own per-area rule decides.
registerFileComponentPrefix('mod.', async (ctx, file) => {
  const r = await recentActivityAccess(ctx, file.contextId);
  if (!r) return false;
  const { activity, canOpen } = r;
  if (r.canManage) return true;
  if (!canOpen) return false;
  const m = getModule(activity.moduleKey);
  const rule = m?.files?.[file.area];
  if (!rule) return false;
  return rule.canRead(buildModuleCtx(ctx), toActivityRef(activity) as never, {
    itemId: file.itemId,
    uploadedById: file.uploadedById,
  });
});

// Activity access for module HTTP routes and actions (late-bound to avoid an import cycle).
provideModuleServices({
  activityAccess: (ctx) => async (activityId) => {
    const r = await recentActivityAccess(ctx, activityId);
    if (!r) return null;
    return { activity: toActivityRef(r.activity), canOpen: r.canOpen, canManage: r.canManage };
  },
});
