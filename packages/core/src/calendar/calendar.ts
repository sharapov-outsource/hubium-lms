import type { CalendarEvent, Db, Prisma } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import { userContext } from '../ai/user-ctx.ts';
import { getCourseOutline } from '../courses/activities.ts';
import { getCourseAccess } from '../courses/courses.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { activeCourseUserIds } from '../enrol/participants.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';

type Tx = Prisma.TransactionClient | Db;

export interface CalendarItem extends CalendarEvent {
  courseName?: string | null;
}

/**
 * Events visible to a user between `from` and `to`. Course events come from the courses the
 * user may open now, and an activity's events only when they may open the activity, as the
 * course page decides: not those of hidden courses, sections or activities, nor of ones
 * behind unmet restrictions, whose names and dates are not theirs to see.
 */
export async function listUserEvents(
  db: Db,
  userId: string,
  range: { from: Date; to: Date; courseId?: string },
): Promise<CalendarItem[]> {
  const now = new Date();
  const enrolments = await db.enrolment.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      method: { enabled: true },
      course: { deletedAt: null },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    select: { courseId: true },
  });
  let courseIds = [...new Set(enrolments.map((e) => e.courseId))];
  if (range.courseId) courseIds = courseIds.filter((c) => c === range.courseId);
  const groups = await db.groupMember.findMany({ where: { userId }, select: { groupId: true } });
  const events = await db.calendarEvent.findMany({
    where: {
      visible: true,
      startsAt: { lt: range.to },
      OR: [{ endsAt: { gte: range.from } }, { endsAt: null, startsAt: { gte: range.from } }],
      AND: [
        {
          OR: [
            ...(range.courseId
              ? []
              : [{ scope: 'SITE' as const }, { scope: 'USER' as const, userId }]),
            { scope: 'COURSE', courseId: { in: courseIds } },
            { scope: 'GROUP', groupId: { in: groups.map((g) => g.groupId) } },
          ],
        },
      ],
    },
    orderBy: { startsAt: 'asc' },
    include: { course: { select: { fullName: true } } },
  });
  // per course with events: whether the user sees it, and the activities they may open
  const courses = new Map<string, { activities: boolean }>();
  for (const e of events)
    if (e.courseId)
      courses.set(e.courseId, {
        activities: !!e.activityId || !!courses.get(e.courseId)?.activities,
      });
  const seen = new Set<string>();
  const openable = new Set<string>();
  // an activity's expected completion date is its learners', until they complete it
  const expected = events.filter((e) => e.kind === 'EXPECTED');
  const learns = new Set<string>();
  if (courses.size) {
    const ctx = await userContext(db, userId);
    for (const [courseId, { activities }] of courses) {
      if (!activities) {
        if ((await getCourseAccess(ctx, courseId)).canView) seen.add(courseId);
        continue;
      }
      const outline = await getCourseOutline(ctx, courseId).catch(() => null);
      if (!outline) continue;
      seen.add(courseId);
      for (const section of outline)
        for (const a of section.activities) if (a.available) openable.add(a.activity.id);
      if (
        expected.some((e) => e.courseId === courseId) &&
        (await ctx.perm.can('grade:view', courseId))
      )
        learns.add(courseId);
    }
  }
  const completed = new Set(
    expected.length
      ? (
          await db.activityCompletion.findMany({
            where: {
              userId,
              activityId: { in: expected.flatMap((e) => (e.activityId ? [e.activityId] : [])) },
              state: { not: 'INCOMPLETE' },
            },
            select: { activityId: true },
          })
        ).map((c) => c.activityId)
      : [],
  );
  return events
    .filter((e) => !e.courseId || seen.has(e.courseId))
    .filter((e) => !e.activityId || openable.has(e.activityId))
    .filter(
      (e) =>
        e.kind !== 'EXPECTED' ||
        (!!e.courseId && learns.has(e.courseId) && !completed.has(e.activityId ?? '')),
    )
    .map(({ course, ...e }) => ({ ...e, courseName: course?.fullName ?? null }));
}

export const EventInput = z.object({
  scope: z.enum(['SITE', 'COURSE', 'USER']),
  courseId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(5000).default(''),
  location: z.string().trim().max(255).default(''),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional().nullable(),
  allDay: z.boolean().default(false),
});

export const createEvent = defineOperation({
  name: 'calendar.create',
  offline: 'replay',
  input: EventInput,
  async authorize(ctx, i) {
    if (i.scope === 'USER') await ctx.perm.require('calendar:manageown');
    else if (i.scope === 'SITE') await ctx.perm.require('calendar:managesite');
    else {
      if (!i.courseId)
        throw new ValidationError({ courseId: [msg('errors.calendar.courseRequired')] });
      await ctx.perm.require('calendar:managecourse', i.courseId);
    }
  },
  async handler(ctx, input) {
    if (input.endsAt && input.endsAt < input.startsAt)
      throw new ValidationError({ endsAt: [msg('errors.calendar.endBeforeStart')] });
    const e = await ctx.tx.calendarEvent.create({
      data: {
        scope: input.scope,
        courseId: input.scope === 'COURSE' ? input.courseId : null,
        userId: input.scope === 'USER' ? ctx.perm.userId : null,
        kind: 'CUSTOM',
        title: input.title,
        description: input.description,
        location: input.location,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        allDay: input.allDay,
        createdById: ctx.perm.userId,
      },
    });
    return { id: e.id };
  },
});

export const deleteEvent = defineOperation({
  name: 'calendar.delete',
  offline: 'guarded',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, { id }) {
    const e = await ctx.db.calendarEvent.findUnique({ where: { id } });
    if (!e) throw new NotFoundError('Event');
    if (e.activityId) throw new ForbiddenError(msg('errors.calendar.activityEvent'));
    if (e.subscriptionId) throw new ForbiddenError(msg('errors.calendar.importedEvent'));
    if (e.scope === 'USER' && e.userId === ctx.perm.userId) return;
    if (e.scope === 'COURSE' && e.courseId)
      return ctx.perm.require('calendar:managecourse', e.courseId);
    if (e.scope === 'SITE') return ctx.perm.require('calendar:managesite');
    throw new ForbiddenError();
  },
  async handler(ctx, { id }) {
    await ctx.tx.calendarEvent.delete({ where: { id } });
    return { id };
  },
});

// ── iCal feed ─────────────────────────────────────────────────────────────────

/** Returns a fresh feed token (stored hashed); replaces any previous one. */
export async function resetFeedToken(db: Tx, userId: string): Promise<string> {
  const token = randomToken(24);
  await db.calendarFeedToken.upsert({
    where: { userId },
    create: { userId, tokenHash: sha256Hex(token) },
    // createdAt: when the link in use was issued
    update: { tokenHash: sha256Hex(token), createdAt: new Date() },
  });
  return token;
}

/** A new address of the person's own calendar feed: the previous one stops working. */
export const resetMyFeedToken = defineOperation({
  name: 'calendar.feedToken.reset',
  offline: 'online',
  input: z.object({}),
  async handler(ctx) {
    if (ctx.actor.kind !== 'user') throw new ForbiddenError();
    return { token: await resetFeedToken(ctx.tx, ctx.actor.userId) };
  },
});

/** Whose feed a token opens: an active account's only. */
export async function userForFeedToken(db: Tx, token: string): Promise<string | null> {
  const row = await db.calendarFeedToken.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: { user: { select: { id: true, status: true, deletedAt: true } } },
  });
  return row && row.user.status === 'ACTIVE' && !row.user.deletedAt ? row.user.id : null;
}

function icsDate(d: Date, allDay = false): string {
  const iso = d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return allDay ? iso.slice(0, 8) : iso;
}

function icsEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Folds lines at 75 octets as RFC 5545 requires. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

export function toICal(
  events: CalendarItem[],
  opts: { name: string; host: string; baseUrl: string },
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hubium//LMS//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsEscape(opts.name)}`,
  ];
  const stamp = icsDate(new Date());
  for (const e of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.id}@${opts.host}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (e.allDay) {
      // the end of a date is exclusive in iCalendar: the day after the last one
      const last = e.endsAt && e.endsAt > e.startsAt ? e.endsAt : e.startsAt;
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.startsAt, true)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(new Date(last.getTime() + 86_400_000), true)}`);
    } else {
      lines.push(`DTSTART:${icsDate(e.startsAt)}`);
      lines.push(`DTEND:${icsDate(e.endsAt ?? e.startsAt)}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.courseName ? `${e.title} (${e.courseName})` : e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    if (e.activityId && e.courseId)
      lines.push(`URL:${opts.baseUrl}/course/${e.courseId}/a/${e.activityId}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function upcomingRange(days = 14, now = new Date()) {
  return { from: now, to: new Date(now.getTime() + days * 86_400_000) };
}

/**
 * Cron (hourly): reminds about custom course, group and personal events starting in
 * 24-25 hours. Activity dates (due dates) are reminded by their modules.
 */
export async function sendCalendarReminders(db: Db, now = new Date()): Promise<number> {
  // Two hours wide, so a late or skipped run still reminds; sent reminders are not repeated.
  const from = new Date(now.getTime() + 23 * 3600_000);
  const to = new Date(now.getTime() + 25 * 3600_000);
  const events = await db.calendarEvent.findMany({
    where: {
      activityId: null,
      visible: true,
      scope: { in: ['COURSE', 'GROUP', 'USER'] },
      startsAt: { gte: from, lt: to },
      // learners cannot open hidden or deleted courses
      OR: [{ courseId: null }, { course: { visible: true, deletedAt: null } }],
    },
    include: { course: { select: { fullName: true } } },
  });
  let n = 0;
  for (const e of events) {
    await db.$transaction(async (tx) => {
      const candidates =
        e.scope === 'USER'
          ? e.userId
            ? [e.userId]
            : []
          : e.courseId
            ? await activeCourseUserIds(tx, e.courseId, {
                groupId: e.scope === 'GROUP' ? e.groupId : null,
                now,
              })
            : [];
      const done = new Set(
        (
          await tx.notification.findMany({
            where: {
              type: 'calendar.reminder',
              userId: { in: candidates },
              data: { path: ['eventId'], equals: e.id },
            },
            select: { userId: true },
          })
        ).map((r) => r.userId),
      );
      const users = candidates.filter((u) => !done.has(u));
      if (!users.length) return;
      n += await notifyUsers(tx, users, {
        type: 'calendar.reminder',
        title: { key: 'notifications.text.calendarReminder', values: { title: e.title } },
        body: e.course?.fullName ?? '',
        url: `/calendar?date=${e.startsAt.toISOString().slice(0, 10)}`,
        courseId: e.courseId,
        data: { eventId: e.id },
      });
    });
  }
  return n;
}
