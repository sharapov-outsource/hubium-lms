import { registerFileArea, registerFileComponentPrefix } from '../files/files.ts';
import { buildModuleCtx, toActivityRef } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { getActivityAccess } from './activities.ts';
import { getCourseAccess } from './courses.ts';

// File read rules for course-level areas and activity modules.

// Course cover images appear in the public catalog.
registerFileArea('course', 'image', async () => true);

// Images embedded in course/activity rich text: anyone who can view the course.
registerFileArea('course', 'editor', async (ctx, file) => {
  const course = await ctx.db.course.findUnique({
    where: { id: file.contextId },
    select: { id: true },
  });
  if (!course) return false;
  return (await getCourseAccess(ctx, course.id)).canView;
});

// Activity module areas: the viewer must be able to open the activity; managers always can;
// otherwise the module's own per-area rule decides.
registerFileComponentPrefix('mod.', async (ctx, file) => {
  const { activity, access, canOpen } = await getActivityAccess(ctx, file.contextId).catch(() => ({
    activity: null,
    access: null,
    canOpen: false,
  }));
  if (!activity || !access) return false;
  if (access.canManageActivities) return true;
  if (!canOpen) return false;
  const m = getModule(activity.moduleKey);
  const rule = m?.files?.[file.area];
  if (!rule) return false;
  return rule.canRead(buildModuleCtx(ctx), toActivityRef(activity) as never, {
    itemId: file.itemId,
    uploadedById: file.uploadedById,
  });
});
