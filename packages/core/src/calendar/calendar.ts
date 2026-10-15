import type { CalendarEvent, Db, Prisma } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { activeCourseUserIds } from '../enrol/participants.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';
import { isModuleEnabled } from '../settings/modules.ts';
import { getAllSettings } from '../settings/settings.ts';

type Tx = Prisma.TransactionClient | Db;

export interface CalendarItem extends CalendarEvent {
  courseName?: string | null;
}

/** Events visible to a user between `from` and `to`. */
export async function listUserEvents(
  db: Tx,
  userId: string,
  range: { from: Date; to: Date; courseId?: string },
): Promise<CalendarItem[]> {
  const now = new Date();
  const enrolments = await db.enrolment.findMany({
    where: {
      userId,
      status: 'ACTIVE',
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
            {
              scope: 'COURSE',
              courseId: { in: courseIds },
              OR: [{ activityId: null }, { activityId: { not: null } }],
            },
            { scope: 'GROUP', groupId: { in: groups.map((g) => g.groupId) } },
          ],
        },
      ],
    },
    orderBy: { startsAt: 'asc' },
    include: { course: { select: { fullName: true } } },
  });
  // Hide events of deleted or hidden activities and of activity types that are turned off.
  const actIds = events.map((e) => e.activityId).filter((x): x is string => !!x);
  const acts = actIds.length
    ? await db.activity.findMany({
        where: { id: { in: actIds } },
        select: { id: true, deletedAt: true, visibility: true, moduleKey: true },
      })
    : [];
  const settings = await getAllSettings(db);
  const hidden = new Set(
    acts
      .filter(
        (a) => a.deletedAt || a.visibility !== 'SHOWN' || !isModuleEnabled(settings, a.moduleKey),
      )
      .map((a) => a.id),
  );
  return events
    .filter((e) => !e.activityId || !hidden.has(e.activityId))
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
  input: EventInput,
  async authorize(ctx, i) {
    if (i.scope === 'USER') await ctx.perm.require('calendar:manageown');
    else if (i.scope === 'SITE') await ctx.perm.require('calendar:managesite');
    else {
      if (!i.courseId) throw new ValidationError({ courseId: ['Course is required'] });
      await ctx.perm.require('calendar:managecourse', i.courseId);
    }
  },
  async handler(ctx, input) {
    if (input.endsAt && input.endsAt < input.startsAt)
      throw new ValidationError({ endsAt: ['End must be after start'] });
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
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, { id }) {
    const e = await ctx.db.calendarEvent.findUnique({ where: { id } });
    if (!e) throw new NotFoundError('Event');
    if (e.activityId) throw new ForbiddenError('Activity events are managed by the activity');
    if (e.subscriptionId)
      throw new ForbiddenError('Imported events go when their import or subscription is removed');
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
    update: { tokenHash: sha256Hex(token) },
  });
  return token;
}

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
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.startsAt, true)}`);
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

export async function requireOwnEvents(ctx: RequestContext) {
  if (!ctx.perm.userId) throw new ForbiddenError();
  return ctx.perm.userId;
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
