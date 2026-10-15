import type { CalendarSubscription, Db, Prisma } from '@hubium/db';
import { log } from '@hubium/log';
import { checkUrlShape, safeFetch } from '@hubium/module-sdk/net';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings } from '../settings/settings.ts';
import { parseIcs } from './ics.ts';

// Calendar imports and subscriptions, as Moodle's "Import or subscribe to calendar": an
// .ics file imported once, or a feed by URL refreshed on a schedule, into a user's own
// calendar, a course's or the site's. Their events are read-only copies kept by UID, and
// go with the subscription.

const logger = log('calendar');

type Tx = Prisma.TransactionClient | Db;

export const CALENDAR_FEED_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxEvents: 5000,
  timeoutMs: 20_000,
  /** Occurrences kept: a year back and two years ahead. */
  backDays: 365,
  aheadDays: 730,
};

/** Refresh intervals offered: an hour, a day, a week. */
export const POLL_SECONDS = [3600, 86_400, 604_800] as const;

const Target = z.object({
  scope: z.enum(['SITE', 'COURSE', 'USER']),
  courseId: z.string().uuid().optional(),
});
type TargetT = z.infer<typeof Target>;

async function authorizeTarget(ctx: RequestContext, t: TargetT) {
  if (t.scope === 'USER') return ctx.perm.require('calendar:manageown');
  if (t.scope === 'SITE') return ctx.perm.require('calendar:managesite');
  if (!t.courseId) throw new ValidationError({ courseId: ['Course is required'] });
  return ctx.perm.require('calendar:managecourse', t.courseId);
}

/** Throws unless the viewer may change this subscription (as its calendar's events). */
export async function requireSubscription(ctx: RequestContext, id: string) {
  const sub = await ctx.db.calendarSubscription.findUnique({ where: { id } });
  if (!sub) throw new NotFoundError('Subscription');
  if (sub.scope === 'USER') {
    if (sub.userId !== ctx.perm.userId) throw new ForbiddenError();
  } else
    await authorizeTarget(ctx, {
      scope: sub.scope as 'SITE' | 'COURSE',
      courseId: sub.courseId ?? undefined,
    });
  return sub;
}

/** A feed address as fetched: webcal:// is https://. Throws for anything but http(s). */
export function feedUrl(raw: string): string {
  const url = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  try {
    return checkUrlShape(url).toString();
  } catch {
    throw new ValidationError({ url: ['Enter an http(s) or webcal address'] });
  }
}

const SubscriptionBase = Target.extend({ name: z.string().trim().min(1).max(255) });

function owner(ctx: RequestContext, t: TargetT) {
  return {
    scope: t.scope,
    courseId: t.scope === 'COURSE' ? t.courseId : null,
    userId: t.scope === 'USER' ? ctx.perm.userId : null,
    createdById: ctx.perm.userId,
  };
}

/** Subscribes to a feed; the caller fetches it with syncSubscription (outside the transaction). */
export const subscribeCalendar = defineOperation({
  name: 'calendar.subscribe',
  input: SubscriptionBase.extend({
    url: z.string().max(2000),
    pollSeconds: z.coerce
      .number()
      .int()
      .refine((n) => (POLL_SECONDS as readonly number[]).includes(n), 'Unknown interval'),
  }),
  authorize: authorizeTarget,
  async handler(ctx, input) {
    const sub = await ctx.tx.calendarSubscription.create({
      data: {
        ...owner(ctx, input),
        name: input.name,
        url: feedUrl(input.url),
        pollSeconds: input.pollSeconds,
      },
    });
    return { id: sub.id };
  },
});

/** Imports the events of an .ics file once. */
export const importCalendarFile = defineOperation({
  name: 'calendar.import',
  input: SubscriptionBase.extend({ content: z.string().max(CALENDAR_FEED_LIMITS.maxBytes) }),
  authorize: authorizeTarget,
  async handler(ctx, input) {
    const sub = await ctx.tx.calendarSubscription.create({
      data: { ...owner(ctx, input), name: input.name, url: null, pollSeconds: 0 },
    });
    const r = await applyFeed(ctx.tx, sub, input.content, ctx.now);
    await ctx.tx.calendarSubscription.update({
      where: { id: sub.id },
      data: { lastSyncAt: ctx.now },
    });
    return { id: sub.id, ...r };
  },
});

export const unsubscribeCalendar = defineOperation({
  name: 'calendar.unsubscribe',
  input: z.object({ id: z.string().uuid() }),
  authorize: async (ctx, i) => void (await requireSubscription(ctx, i.id)),
  async handler(ctx, { id }) {
    await ctx.tx.calendarSubscription.delete({ where: { id } });
    return { id };
  },
});

/** Subscriptions the viewer may change: their own, their courses', and the site's. */
export async function listSubscriptions(ctx: RequestContext, courseIds: string[]) {
  const userId = ctx.perm.userId;
  if (!userId) return [];
  const courses: string[] = [];
  for (const c of courseIds) if (await ctx.perm.can('calendar:managecourse', c)) courses.push(c);
  const site = await ctx.perm.can('calendar:managesite');
  return ctx.db.calendarSubscription.findMany({
    where: {
      OR: [
        { scope: 'USER', userId },
        ...(courses.length ? [{ scope: 'COURSE' as const, courseId: { in: courses } }] : []),
        ...(site ? [{ scope: 'SITE' as const }] : []),
      ],
    },
    include: { course: { select: { fullName: true } }, _count: { select: { events: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

/** The zone of times without one: the owner's for a personal calendar, else the site's. */
async function feedZone(db: Tx, sub: CalendarSubscription): Promise<string> {
  const settings = await getAllSettings(db);
  const user = sub.userId
    ? await db.user.findUnique({ where: { id: sub.userId }, select: { timezone: true } })
    : null;
  return user?.timezone || settings['site.defaultTimezone'];
}

/** Replaces the subscription's events with those of the feed text. */
async function applyFeed(tx: Tx, sub: CalendarSubscription, text: string, now: Date) {
  let parsed: ReturnType<typeof parseIcs>;
  try {
    parsed = parseIcs(text, {
      timeZone: await feedZone(tx, sub),
      from: new Date(now.getTime() - CALENDAR_FEED_LIMITS.backDays * 86_400_000),
      to: new Date(now.getTime() + CALENDAR_FEED_LIMITS.aheadDays * 86_400_000),
      maxEvents: CALENDAR_FEED_LIMITS.maxEvents,
    });
  } catch {
    throw new ValidationError({ content: ['This is not an iCalendar (.ics) file'] });
  }
  const old = await tx.calendarEvent.findMany({
    where: { subscriptionId: sub.id },
    select: {
      id: true,
      uid: true,
      title: true,
      description: true,
      location: true,
      startsAt: true,
      endsAt: true,
      allDay: true,
    },
  });
  const byUid = new Map(old.map((e) => [e.uid, e]));
  const fresh = [];
  for (const e of parsed.events) {
    const data = {
      title: e.summary,
      description: e.description,
      location: e.location,
      startsAt: e.start,
      endsAt: e.end,
      allDay: e.allDay,
    };
    const had = byUid.get(e.uid);
    byUid.delete(e.uid);
    if (!had) {
      fresh.push({
        ...data,
        scope: sub.scope,
        courseId: sub.courseId,
        userId: sub.userId,
        kind: 'CUSTOM' as const,
        subscriptionId: sub.id,
        uid: e.uid,
        createdById: sub.createdById,
      });
      continue;
    }
    const same =
      had.title === data.title &&
      had.description === data.description &&
      had.location === data.location &&
      had.startsAt.getTime() === data.startsAt.getTime() &&
      (had.endsAt?.getTime() ?? null) === (data.endsAt?.getTime() ?? null) &&
      had.allDay === data.allDay;
    if (!same) await tx.calendarEvent.update({ where: { id: had.id }, data });
  }
  if (fresh.length) await tx.calendarEvent.createMany({ data: fresh });
  // gone from the feed
  if (byUid.size)
    await tx.calendarEvent.deleteMany({
      where: { id: { in: [...byUid.values()].map((e) => e.id) } },
    });
  return {
    events: parsed.events.length,
    simplified: parsed.simplified,
    truncated: parsed.truncated,
  };
}

/** Reads at most `max` bytes of a response body; throws when it is longer. */
async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`The feed is larger than ${Math.round(max / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches a subscribed feed and updates its events. Records the time and any error on
 * the subscription, then rethrows the error.
 */
export async function syncSubscription(db: Db, id: string, now = new Date()) {
  const sub = await db.calendarSubscription.findUniqueOrThrow({ where: { id } });
  if (!sub.url) return { events: await db.calendarEvent.count({ where: { subscriptionId: id } }) };
  try {
    const res = await safeFetch(sub.url, {
      headers: { accept: 'text/calendar, */*;q=0.5' },
      signal: AbortSignal.timeout(CALENDAR_FEED_LIMITS.timeoutMs),
    });
    // not the status: anyone may subscribe, and statuses would probe other servers
    if (!res.ok) throw new Error('The address gave no calendar');
    const text = await readLimited(res, CALENDAR_FEED_LIMITS.maxBytes);
    const r = await db.$transaction((tx) => applyFeed(tx, sub, text, now), { timeout: 60_000 });
    await db.calendarSubscription.update({
      where: { id },
      data: { lastSyncAt: now, lastError: null },
    });
    return r;
  } catch (e) {
    const message =
      e instanceof ValidationError
        ? 'This is not an iCalendar (.ics) file'
        : e instanceof Error
          ? e.message
          : String(e);
    await db.calendarSubscription.update({
      where: { id },
      data: { lastSyncAt: now, lastError: message.slice(0, 500) },
    });
    throw e instanceof ValidationError ? e : new ValidationError({ url: [message] });
  }
}

/** Cron (hourly): refreshes the subscriptions whose interval has passed. */
export async function syncDueSubscriptions(db: Db, now = new Date()): Promise<number> {
  const subs = await db.calendarSubscription.findMany({
    where: { url: { not: null }, pollSeconds: { gt: 0 } },
    select: { id: true, lastSyncAt: true, pollSeconds: true },
  });
  let n = 0;
  for (const s of subs) {
    // a few minutes early, so an hourly feed is not skipped for a run that starts late
    const due = !s.lastSyncAt || s.lastSyncAt.getTime() + (s.pollSeconds - 300) * 1000 <= +now;
    if (!due) continue;
    try {
      await syncSubscription(db, s.id, now);
      n++;
    } catch (e) {
      logger.warn({ err: e, subscriptionId: s.id }, 'calendar feed not refreshed');
    }
  }
  return n;
}
