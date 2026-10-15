import type { Prisma } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { removeCourseMembership } from '../enrol/enrol.ts';
import { NotFoundError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { recomputeAllTotals } from '../grades/gradebook.ts';
import { buildModuleCtx, toActivityRef } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { defineOperation } from '../operation.ts';
import { syncCalendar } from './activities.ts';

// Course reset, as in Moodle: the course, its activities and settings stay; learners'
// data goes as chosen, and every date can move to a new start (a new term).

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Moves every ISO date-time string in a JSON value by `ms` (settings, access rules). */
export function shiftIsoDates<T>(value: T, ms: number): T {
  if (typeof value === 'string')
    return (ISO_DATETIME.test(value) ? new Date(Date.parse(value) + ms).toISOString() : value) as T;
  if (Array.isArray(value)) return value.map((v) => shiftIsoDates(v, ms)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, shiftIsoDates(v, ms)]),
    ) as T;
  return value;
}

export const ResetInput = z.object({
  courseId: z.string().uuid(),
  /**
   * A new start: every date in the course moves by the difference. A plain date
   * (YYYY-MM-DD) keeps the time of day of the current start, so days move whole.
   */
  startDate: z
    .string()
    .optional()
    .refine((v) => !v || !Number.isNaN(Date.parse(v)), 'Invalid date'),
  /** Activity types whose learners' work goes (attempts, submissions, posts…). */
  activityData: z.array(z.string()).default([]),
  grades: z.boolean().default(false),
  completion: z.boolean().default(false),
  /** People holding these roles in the course are unenrolled. */
  unenrolRoleIds: z.array(z.string().uuid()).default([]),
  groupMembers: z.boolean().default(false),
  groups: z.boolean().default(false),
  groupings: z.boolean().default(false),
  /** Course events of the calendar (activity dates follow the activities). */
  events: z.boolean().default(false),
  announcements: z.boolean().default(false),
});

export interface ResetReport {
  activities: number;
  grades: number;
  completions: number;
  unenrolled: number;
  groups: number;
  events: number;
  announcements: number;
  shiftedDays: number;
}

/** What the reset page offers: activity types with learners' data, roles with people. */
export async function resetOverview(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('course:reset', courseId);
  const course = await ctx.db.course.findUnique({
    where: { id: courseId },
    select: { startDate: true },
  });
  if (!course) throw new NotFoundError('Course');
  const [activities, roles, counts] = await Promise.all([
    ctx.db.activity.groupBy({
      by: ['moduleKey'],
      where: { courseId, deletedAt: null },
      _count: true,
    }),
    ctx.db.roleAssignment.groupBy({
      by: ['roleId'],
      where: { contextId: courseId },
      _count: true,
    }),
    Promise.all([
      ctx.db.grade.count({ where: { item: { courseId } } }),
      ctx.db.activityCompletion.count({ where: { activity: { courseId } } }),
      ctx.db.group.count({ where: { courseId } }),
      ctx.db.calendarEvent.count({ where: { courseId, activityId: null } }),
      ctx.db.announcement.count({ where: { courseId } }),
    ]),
  ]);
  const [grades, completions, groups, events, announcements] = counts;
  return {
    startDate: course.startDate,
    modules: activities
      .filter((a) => getModule(a.moduleKey)?.reset)
      .map((a) => ({ key: a.moduleKey, activities: a._count })),
    roles: roles.map((r) => ({ roleId: r.roleId, people: r._count })),
    grades,
    completions,
    groups,
    events,
    announcements,
  };
}

export const resetCourse = defineOperation({
  name: 'course.reset',
  input: ResetInput,
  authorize: (ctx, i) => ctx.perm.require('course:reset', i.courseId),
  async handler(ctx, input): Promise<ResetReport> {
    const { courseId } = input;
    const tx = ctx.tx;
    const course = await tx.course.findUnique({ where: { id: courseId } });
    if (!course || course.deletedAt) throw new NotFoundError('Course');
    const report: ResetReport = {
      activities: 0,
      grades: 0,
      completions: 0,
      unenrolled: 0,
      groups: 0,
      events: 0,
      announcements: 0,
      shiftedDays: 0,
    };
    const mctx = buildModuleCtx(ctx, tx);

    // learners' work in the chosen activity types, with its grades and files
    const reset = await tx.activity.findMany({
      where: { courseId, deletedAt: null, moduleKey: { in: input.activityData } },
    });
    for (const a of reset) {
      const m = getModule(a.moduleKey);
      if (!m?.reset) continue;
      await m.reset.userData(mctx, toActivityRef(a));
      await tx.gradingInstance.deleteMany({ where: { definition: { activityId: a.id } } });
      const areas = m.backup?.userFileAreas ?? [];
      if (areas.length)
        await tx.file.deleteMany({
          where: { contextId: a.id, component: `mod.${a.moduleKey}`, area: { in: areas } },
        });
      report.grades += (await tx.grade.deleteMany({ where: { item: { activityId: a.id } } })).count;
      report.activities++;
    }
    if (input.grades)
      report.grades += (await tx.grade.deleteMany({ where: { item: { courseId } } })).count;
    else if (report.grades) await recomputeAllTotals(tx, courseId);

    if (input.completion) {
      report.completions = (
        await tx.activityCompletion.deleteMany({ where: { activity: { courseId } } })
      ).count;
      await tx.courseCompletion.deleteMany({ where: { courseId } });
    }

    if (input.unenrolRoleIds.length) {
      const people = await tx.roleAssignment.findMany({
        where: { contextId: courseId, roleId: { in: input.unenrolRoleIds } },
        select: { userId: true },
        distinct: ['userId'],
      });
      for (const { userId } of people) {
        const enrolments = await tx.enrolment.findMany({ where: { courseId, userId } });
        await tx.roleAssignment.deleteMany({
          where: {
            OR: [
              { enrolmentId: { in: enrolments.map((e) => e.id) } },
              { userId, contextId: courseId },
            ],
          },
        });
        await tx.enrolment.deleteMany({ where: { courseId, userId } });
        await removeCourseMembership(ctx, tx, courseId, userId);
        report.unenrolled++;
      }
    }

    if (input.groups) report.groups = (await tx.group.deleteMany({ where: { courseId } })).count;
    else if (input.groupMembers)
      await tx.groupMember.deleteMany({ where: { group: { courseId } } });
    if (input.groupings) await tx.grouping.deleteMany({ where: { courseId } });

    if (input.events) {
      report.events = (
        await tx.calendarEvent.deleteMany({ where: { courseId, activityId: null } })
      ).count;
      // imports and subscriptions too, or they would bring the events back
      await tx.calendarSubscription.deleteMany({ where: { courseId } });
    }
    if (input.announcements)
      report.announcements = (await tx.announcement.deleteMany({ where: { courseId } })).count;

    const newStart = input.startDate
      ? new Date(
          /^\d{4}-\d{2}-\d{2}$/.test(input.startDate) && course.startDate
            ? `${input.startDate}${course.startDate.toISOString().slice(10)}`
            : input.startDate,
        )
      : null;
    if (newStart && course.startDate) {
      const ms = newStart.getTime() - course.startDate.getTime();
      if (ms) await shiftCourseDates(tx, courseId, ms);
      report.shiftedDays = Math.round(ms / 86_400_000);
    } else if (newStart) {
      await tx.course.update({ where: { id: courseId }, data: { startDate: newStart } });
    }

    await logEvent(tx, {
      name: 'course.reset',
      actorId: ctx.perm.userId,
      courseId,
      contextId: courseId,
      data: { ...report, activityData: input.activityData, unenrolRoleIds: input.unenrolRoleIds },
      origin: ctx.origin,
    });
    return report;
  },
});

/** Moves the course, its activities' dates and access rules, and its events by `ms`. */
async function shiftCourseDates(tx: Prisma.TransactionClient, courseId: string, ms: number) {
  const course = await tx.course.findUniqueOrThrow({ where: { id: courseId } });
  const at = (d: Date | null) => (d ? new Date(d.getTime() + ms) : null);
  await tx.course.update({
    where: { id: courseId },
    data: { startDate: at(course.startDate), endDate: at(course.endDate) },
  });
  for (const a of await tx.activity.findMany({ where: { courseId, deletedAt: null } })) {
    const updated = await tx.activity.update({
      where: { id: a.id },
      data: {
        settings: shiftIsoDates(a.settings, ms) as Prisma.InputJsonValue,
        ...(a.availability
          ? { availability: shiftIsoDates(a.availability, ms) as Prisma.InputJsonValue }
          : {}),
        completionExpectedAt: at(a.completionExpectedAt),
      },
    });
    // activity events follow the new settings
    await syncCalendar(tx, updated);
  }
  // a subscription's events keep the dates of their feed
  for (const e of await tx.calendarEvent.findMany({
    where: { courseId, activityId: null, subscriptionId: null },
  }))
    await tx.calendarEvent.update({
      where: { id: e.id },
      data: { startsAt: at(e.startsAt)!, endsAt: at(e.endsAt) },
    });
}
