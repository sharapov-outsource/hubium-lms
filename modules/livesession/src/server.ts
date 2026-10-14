import { createHmac, timingSafeEqual } from 'node:crypto';
import { log } from '@hubium/log';
import { type ActivityRef, defineAction, defineModule, type ModuleCtx } from '@hubium/module-sdk';
import { bool, isoDate } from '@hubium/module-sdk/fields';
import { z } from 'zod';
import { getProvider, type MeetingSpec, type ProviderKind } from './providers.ts';

const logger = log('livesession');

export * from './providers.ts';

// mod-livesession: scheduled webinars. Joining creates the meeting on demand, maps the
// moderator role from capabilities and records attendance; BBB is polled while live and
// calls back when the meeting ends or a recording is ready.

export const LiveSettings = z
  .object({
    provider: z.enum(['bbb', 'jitsi']).default('jitsi'),
    startsAt: isoDate,
    durationMin: z.coerce
      .number()
      .int()
      .min(5)
      .max(12 * 60)
      .default(60),
    joinEarlyMin: z.coerce.number().int().min(0).max(240).default(15),
    record: bool(false),
    welcome: z.string().trim().max(2000).default(''),
  })
  .refine((s) => !!s.startsAt, { message: 'Set the start time', path: ['startsAt'] });

export type LiveSettingsT = z.output<typeof LiveSettings>;
type Live = ActivityRef<LiveSettingsT>;

/** Meetings stay joinable this long after the planned end. */
export const LATE_GRACE_MIN = 60;

export function meetingIdFor(activityId: string): string {
  return `hubium-${activityId}`;
}

export function sessionWindow(s: LiveSettingsT) {
  const start = new Date(s.startsAt ?? 0);
  return {
    start,
    opensAt: new Date(start.getTime() - s.joinEarlyMin * 60_000),
    endsAt: new Date(start.getTime() + s.durationMin * 60_000),
    closesAt: new Date(start.getTime() + (s.durationMin + LATE_GRACE_MIN) * 60_000),
  };
}

/** Can the user join now? Moderators may open the room any time before it closes. */
export function canJoinAt(
  s: LiveSettingsT,
  now: Date,
  moderator: boolean,
): 'ok' | 'early' | 'over' {
  const w = sessionWindow(s);
  if (now > w.closesAt) return 'over';
  if (!moderator && now < w.opensAt) return 'early';
  return 'ok';
}

function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

const callbackSig = (activityId: string, kind: string) =>
  createHmac('sha256', `livesession:${process.env.APP_SECRET ?? ''}`)
    .update(`${activityId}:${kind}`)
    .digest('base64url');

export function callbackUrl(activityId: string, kind: 'end' | 'recording'): string {
  return `${appUrl()}/api/mod/livesession/${activityId}/callback/${kind}?sig=${callbackSig(activityId, kind)}`;
}

function verifySig(activityId: string, kind: string, sig: string | null): boolean {
  if (!sig) return false;
  const a = Buffer.from(callbackSig(activityId, kind));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

function spec(a: Live): MeetingSpec {
  return {
    meetingId: meetingIdFor(a.id),
    name: a.name,
    welcome: a.settings.welcome || undefined,
    record: a.settings.record,
    durationMin: a.settings.durationMin,
    logoutUrl: `${appUrl()}/course/${a.courseId}/a/${a.id}`,
    endCallbackUrl: callbackUrl(a.id, 'end'),
    recordingReadyUrl: a.settings.record ? callbackUrl(a.id, 'recording') : undefined,
  };
}

async function markEnded(ctx: ModuleCtx, activityId: string) {
  await ctx.db.liveMeeting.updateMany({
    where: { activityId, status: { not: 'ENDED' } },
    data: { status: 'ENDED', endedAt: ctx.now },
  });
}

export async function syncRecordings(ctx: ModuleCtx, a: Live): Promise<number> {
  const recs = await getProvider(a.settings.provider as ProviderKind).recordings(
    meetingIdFor(a.id),
  );
  for (const r of recs) {
    await ctx.db.liveRecording.upsert({
      where: { recordId: r.recordId },
      create: { activityId: a.id, ...r },
      update: { url: r.url, startedAt: r.startedAt, durationSec: r.durationSec },
    });
  }
  return recs.length;
}

/** One polling pass: attendance for running BBB meetings, auto-end of stale ones. */
export async function pollMeetings(ctx: ModuleCtx, intervalSec = 60): Promise<number> {
  const live = await ctx.db.liveMeeting.findMany({
    where: { status: 'LIVE' },
    include: { activity: true },
  });
  let n = 0;
  for (const m of live) {
    const settings = LiveSettings.safeParse(m.activity.settings);
    if (!settings.success) continue;
    const w = sessionWindow(settings.data);
    let info: Awaited<ReturnType<ReturnType<typeof getProvider>['info']>> = null;
    try {
      info = await getProvider(settings.data.provider).info(m.meetingId);
    } catch (e) {
      logger.warn({ err: e, meetingId: m.meetingId }, 'meeting status poll failed');
      continue;
    }
    if (info?.running) {
      for (const at of info.attendees) {
        const r = await ctx.db.liveAttendance.updateMany({
          where: { activityId: m.activityId, userId: at.userId },
          data: { lastSeenAt: ctx.now, durationSec: { increment: intervalSec } },
        });
        n += r.count;
      }
    } else if (
      (info && m.startedAt && ctx.now.getTime() - m.startedAt.getTime() > 5 * 60_000) ||
      ctx.now > w.closesAt
    ) {
      // BBB says it is gone (after a start-up grace), or the slot is long over
      await markEnded(ctx, m.activityId);
    }
  }
  return n;
}

export const livesession = defineModule<LiveSettingsT>({
  key: 'livesession',
  archetype: 'activity',
  icon: 'Presentation',
  supports: { viewCompletion: true, backup: true },
  // recordings are course material and stay
  reset: {
    async userData(ctx, a) {
      await ctx.db.liveAttendance.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return ctx.db.liveAttendance.findMany({
        where: { userId },
        select: { activityId: true, firstJoinAt: true, lastSeenAt: true, joins: true },
      });
    },
  },
  settings: {
    schema: LiveSettings as unknown as z.ZodType<LiveSettingsT>,
    defaults: () => ({
      ...LiveSettings.parse({ startsAt: new Date(Date.now() + 86_400_000).toISOString() }),
    }),
  },
  calendar: {
    events: (a) => {
      if (!a.settings.startsAt) return [];
      const w = sessionWindow(a.settings);
      return [{ kind: 'SESSION', title: a.name, startsAt: w.start, endsAt: w.endsAt }];
    },
  },
  completion: {
    schema: z.object({ attended: bool(false) }),
    async evaluate(ctx, a, userId, rules) {
      if (!(rules as { attended: boolean }).attended) return 'complete';
      const at = await ctx.db.liveAttendance.findUnique({
        where: { activityId_userId: { activityId: a.id, userId } },
      });
      return at ? 'complete' : 'incomplete';
    },
  },
  notifications: { starting: { email: 'IMMEDIATE' } },
  cron: [
    {
      name: 'livesession.poll',
      schedule: '* * * * *',
      handler: (ctx) => pollMeetings(ctx),
    },
    {
      name: 'livesession.recordings.sync',
      schedule: '*/15 * * * *',
      async handler(ctx) {
        const ended = await ctx.db.liveMeeting.findMany({
          where: { status: 'ENDED', endedAt: { gt: new Date(ctx.now.getTime() - 7 * 86_400_000) } },
          include: { activity: true },
        });
        let n = 0;
        for (const m of ended) {
          const s = LiveSettings.safeParse(m.activity.settings);
          if (!s.success || s.data.provider !== 'bbb' || !s.data.record) continue;
          n += await syncRecordings(ctx, {
            id: m.activityId,
            settings: s.data,
          } as Live).catch(() => 0);
        }
        return { recordings: n };
      },
    },
    {
      // Reminder 15 minutes before the start for everyone who can join.
      name: 'livesession.remind',
      schedule: '*/5 * * * *',
      async handler(ctx) {
        const events = await ctx.db.calendarEvent.findMany({
          where: {
            moduleKey: 'livesession',
            kind: 'SESSION',
            startsAt: {
              gt: new Date(ctx.now.getTime() + 10 * 60_000),
              lte: new Date(ctx.now.getTime() + 15 * 60_000),
            },
          },
          select: { activityId: true, courseId: true, title: true },
        });
        for (const e of events) {
          if (!e.activityId || !e.courseId) continue;
          const users = await ctx.perm.usersWithCap('mod.livesession:join', e.activityId);
          await ctx.notify.send(users, {
            type: 'livesession.starting',
            title: { key: 'mod.livesession.notify.startingTitle', values: { name: e.title } },
            url: `/course/${e.courseId}/a/${e.activityId}`,
            courseId: e.courseId,
            contextId: e.activityId,
          });
        }
        return { events: events.length };
      },
    },
  ],
  actions: {
    // Actions that call the meeting server run outside a transaction: a slow BBB must not
    // hold database locks or run past the transaction timeout.
    join: defineAction({
      summary: 'Get a personal link to join the session',
      capability: 'mod.livesession:join',
      mutation: false,
      input: z.object({}),
      async handler(ctx, ref) {
        const a = ref as Live;
        if (ctx.actor.kind !== 'user') throw new Error('Sign in required');
        const userId = ctx.actor.userId;
        const moderator = await ctx.perm.can('mod.livesession:moderate', a.id);
        const when = canJoinAt(a.settings, ctx.now, moderator);
        if (when === 'early') throw new Error('The session has not opened yet');
        if (when === 'over') throw new Error('The session is over');
        const meeting = await ctx.db.liveMeeting.upsert({
          where: { activityId: a.id },
          create: { activityId: a.id, meetingId: meetingIdFor(a.id) },
          update: {},
        });
        if (meeting.status === 'ENDED' && !moderator) throw new Error('The session is over');
        const provider = getProvider(a.settings.provider);
        const s = spec(a);
        // Viewers may only join a room a moderator has started (BBB creates on demand).
        if (meeting.status !== 'LIVE') {
          if (!moderator && provider.kind === 'bbb') {
            throw new Error('Waiting for the teacher to start the session');
          }
          await provider.createMeeting(s);
          await ctx.db.liveMeeting.update({
            where: { id: meeting.id },
            data: { status: 'LIVE', startedAt: meeting.startedAt ?? ctx.now, endedAt: null },
          });
        }
        const user = await ctx.db.user.findUniqueOrThrow({
          where: { id: userId },
          select: { name: true },
        });
        const url = await provider.joinUrl(s, { id: userId, name: user.name, moderator });
        await ctx.db.liveAttendance.upsert({
          where: { activityId_userId: { activityId: a.id, userId } },
          create: {
            activityId: a.id,
            userId,
            moderator,
            firstJoinAt: ctx.now,
            lastSeenAt: ctx.now,
          },
          update: { joins: { increment: 1 }, lastSeenAt: ctx.now },
        });
        await ctx.completion.recompute(a.id, userId);
        await ctx.log('livesession.joined', { activityId: a.id, moderator });
        return { url };
      },
    }),
    end: defineAction({
      summary: 'End the session for everyone',
      capability: 'mod.livesession:moderate',
      mutation: false,
      input: z.object({}),
      async handler(ctx, ref) {
        const a = ref as Live;
        await getProvider(a.settings.provider)
          .end(meetingIdFor(a.id))
          .catch(() => {});
        await markEnded(ctx, a.id);
        return { ok: true };
      },
    }),
    syncRecordings: defineAction({
      summary: 'Fetch the list of recordings from the conferencing server',
      capability: 'mod.livesession:moderate',
      mutation: false,
      input: z.object({}),
      async handler(ctx, ref) {
        return { count: await syncRecordings(ctx, ref as Live) };
      },
    }),
    deleteRecording: defineAction({
      summary: 'Delete a recording',
      capability: 'mod.livesession:moderate',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        await ctx.db.liveRecording.deleteMany({ where: { id: input.id, activityId: a.id } });
        return { ok: true };
      },
    }),
  },
  async http(ctx, req, p) {
    // GET|POST /api/mod/livesession/<activityId>/callback/<end|recording>?sig=…
    const [activityId, kind, which] = p;
    if (kind !== 'callback' || !activityId || (which !== 'end' && which !== 'recording')) {
      return new Response('Not found', { status: 404 });
    }
    const sig = new URL(req.url).searchParams.get('sig');
    if (!verifySig(activityId, which, sig)) return new Response('Forbidden', { status: 403 });
    if (which === 'end') {
      await markEnded(ctx, activityId);
    } else {
      const act = await ctx.db.activity.findUnique({ where: { id: activityId } });
      const s = act ? LiveSettings.safeParse(act.settings) : null;
      if (act && s?.success) {
        await syncRecordings(ctx, { id: act.id, settings: s.data } as Live).catch(() => 0);
      }
    }
    return new Response('ok');
  },
});

export const livesessionModules = [livesession];
