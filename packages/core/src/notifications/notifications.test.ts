import { uuidv7 } from '@hubium/db';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, sentMail, useTestDb } from '../../test/helpers.ts';
import { enrolUsers } from '../enrol/enrol.ts';
import { dispatchRealtime, type RealtimeEvent, subscribeRealtime } from '../realtime.ts';
import {
  applyUnsubscribe,
  FANOUT_CHUNK,
  getNotificationPreferences,
  listNotifications,
  localHour,
  markNotificationsRead,
  notifyUsers,
  parseUnsubscribeToken,
  sendDigests,
  sendNotificationEmails,
  unreadNotificationCount,
  unsubscribeToken,
  updateNotificationPreferences,
} from './notifications.ts';

describe('realtime hub', () => {
  it('dispatches NOTIFY payloads to the addressed users only', () => {
    const got: RealtimeEvent[] = [];
    const off = subscribeRealtime('u1', (e) => got.push(e));
    dispatchRealtime(JSON.stringify({ id: 'e1', t: 'notification.new', u: ['u1', 'u2'] }));
    dispatchRealtime(JSON.stringify({ id: 'e2', t: 'notification.new', u: ['u2'] }));
    dispatchRealtime('not json');
    off();
    dispatchRealtime(JSON.stringify({ id: 'e3', t: 'notification.new', u: ['u1'] }));
    expect(got).toEqual([{ id: 'e1', t: 'notification.new' }]);
  });
});

describe('localHour', () => {
  it('converts to the user time zone', () => {
    const at = new Date('2026-03-01T15:30:00Z');
    expect(localHour(at, 'Europe/Moscow')).toBe(18);
    expect(localHour(at, 'UTC')).toBe(15);
    expect(localHour(at, 'Not/AZone')).toBe(15);
  });
});

describe('notifications', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'NOTIF1');
    await t.db.user.update({ where: { id: f.users.student2 }, data: { locale: 'en' } });
  });
  beforeEach(() => {
    capturedJobs.length = 0;
    sentMail.length = 0;
  });

  it('renders per recipient locale, skips the actor and queues immediate email', async () => {
    const n = await t.db.$transaction((tx) =>
      notifyUsers(tx, [f.users.student1!, f.users.student2!, f.users.teacher!], {
        type: 'enrol.enrolled',
        title: { key: 'notifications.text.enrolled', values: { course: 'Python' } },
        url: `/course/${f.courseId}`,
        actorId: f.users.teacher,
      }),
    );
    expect(n).toBe(2);
    const rows = await t.db.notification.findMany({
      where: { type: 'enrol.enrolled', userId: { in: [f.users.student1!, f.users.student2!] } },
    });
    const byUser = Object.fromEntries(rows.map((r) => [r.userId, r]));
    expect(byUser[f.users.student1!]?.title).toBe('Вы зачислены на курс «Python»');
    expect(byUser[f.users.student2!]?.title).toBe('You were enrolled in “Python”');
    expect(rows.every((r) => r.emailState === 'PENDING')).toBe(true);
    const job = capturedJobs.find((j) => j.name === 'notification.email');
    expect((job!.data as { ids: string[] }).ids.sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it('keeps failed immediate emails pending so the job is retried', async () => {
    const { setMailTransport } = await import('../mail/mail.ts');
    const user = await t.db.user.findFirstOrThrow({ where: { username: 'student3' } });
    const n = await t.db.notification.create({
      data: { userId: user.id, type: 'enrol.enrolled', title: 'Повтор', emailState: 'PENDING' },
    });
    setMailTransport({
      sendMail: async () => {
        throw new Error('SMTP down');
      },
    } as never);
    try {
      await expect(sendNotificationEmails(t.db, [n.id])).rejects.toThrow(/could not be sent/);
    } finally {
      // back to the shared stub from the helpers
      setMailTransport({
        sendMail: async (m: (typeof sentMail)[number]) => {
          sentMail.push(m);
          return { messageId: `test-${sentMail.length}` };
        },
      } as never);
    }
    expect((await t.db.notification.findUniqueOrThrow({ where: { id: n.id } })).emailState).toBe(
      'PENDING',
    );
  });

  it('sends immediate emails with one-click unsubscribe headers', async () => {
    const ids = (
      await t.db.notification.findMany({ where: { emailState: 'PENDING' }, select: { id: true } })
    ).map((r) => r.id);
    expect(await sendNotificationEmails(t.db, ids)).toBe(ids.length);
    expect(sentMail).toHaveLength(ids.length);
    const m = sentMail[0]!;
    expect(m.headers?.['List-Unsubscribe']).toMatch(/^<http.*\/unsubscribe\/.+>$/);
    expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.html).toContain(`/course/${f.courseId}`);
    expect(await t.db.notification.count({ where: { emailState: 'PENDING' } })).toBe(0);
  });

  it('respects preferences: muted type creates nothing, digest is queued for the digest', async () => {
    const s1 = await ctxFor(t.db, f.users.student1!);
    const prefs = await getNotificationPreferences(t.db, f.users.student1!, ['assign']);
    expect(prefs.types.find((p) => p.type === 'assign.graded')).toMatchObject({
      inApp: true,
      email: 'IMMEDIATE',
      labelKey: 'mod.assign.notify.graded',
    });
    await updateNotificationPreferences.run(s1, {
      digestHour: 9,
      prefs: [
        { type: 'calendar.reminder', inApp: false, email: 'OFF' },
        { type: 'announcement.course', inApp: true, email: 'DIGEST' },
        { type: 'no.such', inApp: false, email: 'OFF' },
      ],
    });
    const make = (type: string) =>
      t.db.$transaction((tx) => notifyUsers(tx, [f.users.student1!], { type, title: type }));
    expect(await make('calendar.reminder')).toBe(0);
    expect(await make('announcement.course')).toBe(1);
    const row = await t.db.notification.findFirstOrThrow({
      where: { userId: f.users.student1, type: 'announcement.course' },
    });
    expect(row.emailState).toBe('DIGEST');
    expect(capturedJobs.filter((j) => j.name === 'notification.email')).toHaveLength(0);
  });

  it('sends the digest at the chosen local hour only', async () => {
    await t.db.user.update({
      where: { id: f.users.student1 },
      data: { timezone: 'Europe/Moscow', digestHour: 9 },
    });
    expect(await sendDigests(t.db, new Date('2026-05-01T05:00:00Z'))).toBe(0);
    expect(await sendDigests(t.db, new Date('2026-05-01T06:10:00Z'))).toBe(1);
    expect(sentMail[0]?.subject).toContain('Сводка за день');
    expect(sentMail[0]?.html).toContain('announcement.course');
    expect(
      await t.db.notification.count({ where: { userId: f.users.student1, emailState: 'DIGEST' } }),
    ).toBe(0);
  });

  it('unsubscribe tokens are signed and turn email off without signing in', async () => {
    const token = unsubscribeToken(f.users.student2!, 'enrol.enrolled');
    expect(parseUnsubscribeToken(token)).toEqual({
      userId: f.users.student2,
      type: 'enrol.enrolled',
    });
    expect(parseUnsubscribeToken(`${token}x`)).toBeNull();
    expect(parseUnsubscribeToken('garbage')).toBeNull();
    expect(await applyUnsubscribe(t.db, token, [])).toEqual({ type: 'enrol.enrolled' });
    await t.db.$transaction((tx) =>
      notifyUsers(tx, [f.users.student2!], { type: 'enrol.enrolled', title: 'x' }),
    );
    const last = await t.db.notification.findFirstOrThrow({
      where: { userId: f.users.student2, type: 'enrol.enrolled' },
      orderBy: { id: 'desc' },
    });
    expect(last.emailState).toBe('NONE');
    expect(last.inApp).toBe(true);
    // "*" unsubscribes from every type
    await applyUnsubscribe(t.db, unsubscribeToken(f.users.student2!, '*'), ['assign', 'forum']);
    expect(
      await t.db.notificationPreference.count({
        where: { userId: f.users.student2, email: { not: 'OFF' } },
      }),
    ).toBe(0);
  });

  it('splits large audiences into fan-out jobs', async () => {
    const ids = Array.from({ length: FANOUT_CHUNK * 2 + 10 }, () => uuidv7());
    const n = await t.db.$transaction((tx) =>
      notifyUsers(tx, ids, { type: 'announcement.site', title: 'Hi' }),
    );
    expect(n).toBe(ids.length);
    const jobs = capturedJobs.filter((j) => j.name === 'notification.fanout');
    expect(jobs.map((j) => (j.data as { userIds: string[] }).userIds.length)).toEqual([
      FANOUT_CHUNK,
      FANOUT_CHUNK,
      10,
    ]);
  });

  it('lists, counts and marks read', async () => {
    const s1 = await ctxFor(t.db, f.users.student1!);
    const before = await unreadNotificationCount(t.db, f.users.student1!);
    expect(before).toBeGreaterThan(0);
    const page = await listNotifications(t.db, f.users.student1!, { limit: 1 });
    expect(page.items).toHaveLength(1);
    await markNotificationsRead.run(s1, { ids: [page.items[0]!.id] });
    expect(await unreadNotificationCount(t.db, f.users.student1!)).toBe(before - 1);
    await markNotificationsRead.run(s1, { all: true });
    expect(await unreadNotificationCount(t.db, f.users.student1!)).toBe(0);
  });

  it('manual enrolment by a user notifies the enrolled people', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const other = await t.db.user.findFirstOrThrow({ where: { username: 'assistant' } });
    await enrolUsers.run(admin, {
      courseId: f.courseId,
      userIds: [other.id],
      roleId: f.roles.teacher!,
    });
    const n = await t.db.notification.findFirstOrThrow({
      where: { userId: other.id, type: 'enrol.enrolled' },
    });
    expect(n.url).toBe(`/course/${f.courseId}`);
    expect(n.title).toContain('NOTIF1');
  });
});
