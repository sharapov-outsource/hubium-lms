import {
  callbackUrl,
  type Joiner,
  type LiveProvider,
  type MeetingSpec,
  pollMeetings,
  setProviderFactory,
} from '@hubium/mod-livesession/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { runModuleAction } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { getModule } from './registry.ts';

/** In-memory BBB double. */
class FakeBbb implements LiveProvider {
  readonly kind = 'bbb' as const;
  created: MeetingSpec[] = [];
  ended: string[] = [];
  running = new Set<string>();
  attendees: { userId: string; moderator: boolean }[] = [];
  async createMeeting(m: MeetingSpec) {
    this.created.push(m);
    this.running.add(m.meetingId);
  }
  async joinUrl(m: MeetingSpec, u: Joiner) {
    return `https://bbb.test/join?meeting=${m.meetingId}&role=${u.moderator ? 'MODERATOR' : 'VIEWER'}&user=${u.id}`;
  }
  async end(id: string) {
    this.ended.push(id);
    this.running.delete(id);
  }
  async info(id: string) {
    return { running: this.running.has(id), attendees: this.attendees };
  }
  async recordings() {
    return [
      {
        recordId: 'rec-1',
        url: 'https://bbb.test/playback/rec-1',
        startedAt: new Date(),
        durationSec: 1800,
      },
    ];
  }
}

describe('mod-livesession', () => {
  const t = useTestDb();
  const bbb = new FakeBbb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let liveId: string;

  beforeAll(async () => {
    setProviderFactory(() => bbb);
    f = await courseFixture(t.db, 'LIVE1');
    liveId = (
      await f.addActivity(
        'livesession',
        'Вебинар 1',
        {
          provider: 'bbb',
          startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          durationMin: 60,
          joinEarlyMin: 15,
          record: true,
        },
        { completionMode: 'AUTO', completionRules: { module: { attended: true } } },
      )
    ).id;
  });
  afterAll(() => setProviderFactory(undefined));

  const join = async (userId: string) =>
    (await runModuleAction(await ctxFor(t.db, userId), liveId, 'join', {})) as { url: string };

  it('puts the session in the calendar', async () => {
    const e = await t.db.calendarEvent.findFirstOrThrow({ where: { activityId: liveId } });
    expect(e.kind).toBe('SESSION');
    expect(e.endsAt!.getTime() - e.startsAt.getTime()).toBe(60 * 60_000);
  });

  it('students wait for the teacher; the teacher starts as moderator', async () => {
    await expect(join(f.users.student1!)).rejects.toThrow('Waiting for the teacher');
    const r = await join(f.users.teacher!);
    expect(r.url).toContain('role=MODERATOR');
    expect(bbb.created).toHaveLength(1);
    expect(bbb.created[0]).toMatchObject({ meetingId: `hubium-${liveId}`, record: true });
    expect(bbb.created[0]!.endCallbackUrl).toBe(callbackUrl(liveId, 'end'));
    const s = await join(f.users.student1!);
    expect(s.url).toContain('role=VIEWER');
    await join(f.users.student1!);
    const att = await t.db.liveAttendance.findUniqueOrThrow({
      where: { activityId_userId: { activityId: liveId, userId: f.users.student1! } },
    });
    expect(att).toMatchObject({ joins: 2, moderator: false });
    const c = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: liveId, userId: f.users.student1! } },
    });
    expect(c.state).toBe('COMPLETE');
  });

  it('polling adds time for attendees who are in the room', async () => {
    bbb.attendees = [{ userId: f.users.student1!, moderator: false }];
    const sys = buildModuleCtx(await ctxFor(t.db, 'system'));
    await pollMeetings(sys, 60);
    await pollMeetings(sys, 60);
    const att = await t.db.liveAttendance.findUniqueOrThrow({
      where: { activityId_userId: { activityId: liveId, userId: f.users.student1! } },
    });
    expect(att.durationSec).toBe(120);
  });

  it('the end callback needs a valid signature and closes the meeting', async () => {
    const http = getModule('livesession')!.http!;
    const ctx = buildModuleCtx(await ctxFor(t.db, 'system'));
    const bad = await http(ctx, new Request(`http://x/cb?sig=forged`), [liveId, 'callback', 'end']);
    expect(bad.status).toBe(403);
    const ok = await http(ctx, new Request(callbackUrl(liveId, 'end')), [
      liveId,
      'callback',
      'end',
    ]);
    expect(ok.status).toBe(200);
    expect(
      (await t.db.liveMeeting.findUniqueOrThrow({ where: { activityId: liveId } })).status,
    ).toBe('ENDED');
    await expect(join(f.users.student2!)).rejects.toThrow('over');
    // recording-ready callback pulls the recordings list
    await http(ctx, new Request(callbackUrl(liveId, 'recording')), [
      liveId,
      'callback',
      'recording',
    ]);
    expect(await t.db.liveRecording.count({ where: { activityId: liveId } })).toBe(1);
  });

  it('students cannot moderate; the room cannot be joined long before the start', async () => {
    await expect(
      runModuleAction(await ctxFor(t.db, f.users.student1!), liveId, 'end', {}),
    ).rejects.toThrow();
    const { id } = await f.addActivity('livesession', 'Завтра', {
      provider: 'jitsi',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await expect(
      runModuleAction(await ctxFor(t.db, f.users.student1!), id, 'join', {}),
    ).rejects.toThrow('not opened');
  });
});
