import type { Activity, Db, Prisma } from '@hubium/db';
import { Permissions } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';
import { buildModuleCtx, toActivityRef } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { getSetting } from '../settings/settings.ts';
import { dropAvailabilityRefs, namesActivity } from './availability-refs.ts';

// The recycle bin: activities and courses deleted go there first, and are deleted for good
// by hand or once they have been there for the days the site keeps them (recyclebin.purge).

type Tx = Prisma.TransactionClient;

/** Deletes an activity for good: its module's clean-up (stored packages, media), its
 *  calendar events and its context with what hangs on it. */
export async function purgeActivityRecord(ctx: RequestContext, tx: Tx, a: Activity) {
  await getModule(a.moduleKey)?.lifecycle?.onDelete?.(buildModuleCtx(ctx, tx), toActivityRef(a));
  // calendar events name activities without a foreign key
  await tx.calendarEvent.deleteMany({ where: { activityId: a.id } });
  await tx.questionCategory.deleteMany({ where: { contextId: a.id } });
  await tx.activity.delete({ where: { id: a.id } });
  await tx.context.delete({ where: { id: a.id } });
  // what depended on it opens as if the condition were met
  await dropAvailabilityRefs(tx, a.courseId, namesActivity(a.id));
}

/** Deletes a course for good: each activity as above, then the course's context, which
 *  takes the course and everything below it, and its question bank. */
export async function purgeCourseRecord(ctx: RequestContext, tx: Tx, courseId: string) {
  const activities = await tx.activity.findMany({ where: { courseId } });
  for (const a of activities) {
    await getModule(a.moduleKey)?.lifecycle?.onDelete?.(buildModuleCtx(ctx, tx), toActivityRef(a));
  }
  const ids = activities.map((a) => a.id);
  await tx.calendarEvent.deleteMany({ where: { activityId: { in: ids } } });
  // question categories are keyed by context id without a foreign key
  await tx.questionCategory.deleteMany({ where: { contextId: { in: [courseId, ...ids] } } });
  await tx.context.delete({ where: { id: courseId } });
}

function systemCtx(db: Db, now: Date): RequestContext {
  return {
    db,
    actor: { kind: 'system' },
    perm: new Permissions(db, { kind: 'system' }),
    now,
    locale: 'en',
    origin: 'WORKER',
  };
}

/** Cron: what has been in the recycle bin longer than the site keeps it (none when 0). */
export async function purgeRecycleBin(
  db: Db,
  now = new Date(),
): Promise<{ courses: number; activities: number }> {
  const days = await getSetting(db, 'recyclebin.days');
  if (!days) return { courses: 0, activities: 0 };
  const before = new Date(now.getTime() - days * 86_400_000);
  // the modules' stored objects go once each deletion has committed
  const after: (() => void | Promise<void>)[] = [];
  const ctx = {
    ...systemCtx(db, now),
    afterCommit: (fn: () => void | Promise<void>) => after.push(fn),
  };
  const purge = async (fn: (tx: Tx) => Promise<void>) => {
    after.length = 0;
    await db.$transaction(fn);
    for (const f of after.splice(0)) await f();
  };
  const courses = await db.course.findMany({
    where: { deletedAt: { lt: before } },
    select: { id: true },
  });
  for (const c of courses) await purge((tx) => purgeCourseRecord(ctx, tx, c.id));
  // activities binned in courses that stay
  const activities = await db.activity.findMany({
    where: { deletedAt: { lt: before }, course: { deletedAt: null } },
  });
  for (const a of activities) await purge((tx) => purgeActivityRecord(ctx, tx, a));
  return { courses: courses.length, activities: activities.length };
}
