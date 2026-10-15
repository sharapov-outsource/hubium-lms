import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { msg } from '@hubium/module-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError } from '../errors.ts';
import { localeOfUser } from '../settings/settings.ts';
import { deleteEvent, listUserEvents } from './calendar.ts';
import {
  importCalendarFile,
  subscribeCalendar,
  syncDueSubscriptions,
  syncSubscription,
  unsubscribeCalendar,
} from './subscriptions.ts';

const ics = (events: string[]) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('')}END:VCALENDAR\r\n`;
const ev = (uid: string, start: string, summary: string, extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${start}\r\nSUMMARY:${summary}\r\n${extra}END:VEVENT\r\n`;

const soon = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
};

describe('calendar imports and subscriptions', () => {
  const t = useTestDb();
  let server: Server;
  let feed = { status: 200, body: '' };
  let base = '';

  beforeAll(async () => {
    process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';
    server = createServer((_req, res) => {
      res.writeHead(feed.status, { 'content-type': 'text/calendar' });
      res.end(feed.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const range = () => ({
    from: new Date(Date.now() - 86_400_000),
    to: new Date(Date.now() + 30 * 86_400_000),
  });

  it('imports a file into a personal calendar; its events go with the import', async () => {
    const f = await courseFixture(t.db, 'ICS1');
    const student = await ctxFor(t.db, f.users.student1!);
    const r = await importCalendarFile.run(student, {
      scope: 'USER',
      name: 'Секция',
      content: ics([
        ev('a', soon(2), 'Тренировка', 'RRULE:FREQ=WEEKLY;COUNT=3\r\nLOCATION:Зал 2\r\n'),
        ev('b', soon(3), 'Соревнования'),
      ]),
    });
    expect(r).toMatchObject({ events: 4, simplified: 0 });
    const mine = await listUserEvents(t.db, f.users.student1!, range());
    expect(mine.filter((e) => e.subscriptionId === r.id).map((e) => e.title)).toEqual([
      'Тренировка',
      'Соревнования',
      'Тренировка',
      'Тренировка',
    ]);
    expect(mine.find((e) => e.title === 'Тренировка')!.location).toBe('Зал 2');
    // others do not see it, and its events are not deleted one by one
    expect(
      (await listUserEvents(t.db, f.users.student2!, range())).some(
        (e) => e.subscriptionId === r.id,
      ),
    ).toBe(false);
    await expect(
      deleteEvent.run(student, { id: mine.find((e) => e.subscriptionId === r.id)!.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      importCalendarFile.run(student, { scope: 'USER', name: 'x', content: 'not a calendar' }),
    ).rejects.toMatchObject({ fieldErrors: { content: [expect.stringMatching(/iCalendar/)] } });
    await unsubscribeCalendar.run(student, { id: r.id });
    expect(await t.db.calendarEvent.count({ where: { subscriptionId: r.id } })).toBe(0);
  });

  it('a course subscribes to a feed; refreshes follow it; errors are kept', async () => {
    const f = await courseFixture(t.db, 'ICS2');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const student = await ctxFor(t.db, f.users.student1!);
    // learners do not manage the course calendar
    await expect(
      subscribeCalendar.run(student, {
        scope: 'COURSE',
        courseId: f.courseId,
        name: 'x',
        url: `${base}/x.ics`,
        pollSeconds: 86_400,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      subscribeCalendar.run(teacher, {
        scope: 'COURSE',
        courseId: f.courseId,
        name: 'x',
        url: 'ftp://example.com/x.ics',
        pollSeconds: 86_400,
      }),
    ).rejects.toMatchObject({ fieldErrors: { url: expect.any(Array) } });
    const { id } = await subscribeCalendar.run(teacher, {
      scope: 'COURSE',
      courseId: f.courseId,
      name: 'Расписание',
      url: `${base}/timetable.ics`.replace('http://', 'webcal://').replace('webcal://', 'http://'),
      pollSeconds: 3600,
    });
    feed = {
      status: 200,
      body: ics([ev('l1', soon(1), 'Лекция 1'), ev('l2', soon(2), 'Лекция 2')]),
    };
    await syncSubscription(t.db, id);
    const titles = async () =>
      (await listUserEvents(t.db, f.users.student1!, range()))
        .filter((e) => e.subscriptionId === id)
        .map((e) => e.title);
    expect(await titles()).toEqual(['Лекция 1', 'Лекция 2']);
    // one renamed, one gone, one new
    feed.body = ics([ev('l1', soon(1), 'Лекция 1 (ауд. 5)'), ev('l3', soon(4), 'Лекция 3')]);
    await syncSubscription(t.db, id);
    expect(await titles()).toEqual(['Лекция 1 (ауд. 5)', 'Лекция 3']);
    // a failing feed keeps the events and says so, without the server's status: anyone may
    // subscribe, and statuses would make the subscription a probe of other servers
    feed = { status: 500, body: '' };
    await expect(syncSubscription(t.db, id)).rejects.toMatchObject({
      fieldErrors: { url: ['The address gave no calendar'] },
    });
    // kept in the language of whoever subscribed
    const kept = await t.db.calendarSubscription.findUniqueOrThrow({ where: { id } });
    expect(kept.lastError).toBe(
      msg('errors.calendar.noCalendar').in(await localeOfUser(t.db, kept.createdById)),
    );
    expect(await titles()).toHaveLength(2);
    // refreshed by the schedule only when its interval has passed
    feed = { status: 200, body: ics([ev('l4', soon(5), 'Лекция 4')]) };
    const just = await t.db.calendarSubscription.findUniqueOrThrow({ where: { id } });
    await syncDueSubscriptions(t.db, new Date(just.lastSyncAt!.getTime() + 10 * 60_000));
    expect(await titles()).toHaveLength(2);
    await syncDueSubscriptions(t.db, new Date(just.lastSyncAt!.getTime() + 3600_000));
    expect(await titles()).toEqual(['Лекция 4']);
    expect(
      (await t.db.calendarSubscription.findUniqueOrThrow({ where: { id } })).lastError,
    ).toBeNull();
  });
});
