import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, sentMail, useTestDb } from '../../test/helpers.ts';
import { toggleManualCompletion } from '../completion/completion.ts';
import { ForbiddenError } from '../errors.ts';
import { readSheet } from '../lib/sheets.ts';
import { saveProfileField } from '../users/profile-fields.ts';
import { deleteUser } from '../users/users.ts';
import { reportFieldsOf } from './engine.ts';
import {
  customFieldNames,
  exportReport,
  listReports,
  nextRunAt,
  runDueSchedules,
  saveReport,
  saveSchedule,
  sendSchedule,
  viewReport,
} from './reports.ts';
import { SOURCE_KEYS, SOURCES } from './sources.ts';

describe('custom reports', () => {
  const t = useTestDb();

  it('runs every field of every source', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await saveProfileField.run(admin, {
      shortName: 'faculty',
      name: { ru: 'Факультет' },
      type: 'text',
    });
    const custom = await customFieldNames(t.db);
    expect(custom.user).toContain('faculty');
    for (const source of SOURCE_KEYS) {
      const fields = reportFieldsOf(SOURCES[source]!, custom);
      const { id } = await saveReport.run(admin, {
        name: source,
        source,
        columns: fields.map((f) => ({ field: f.key })),
      });
      const v = await viewReport(admin, id, {});
      expect(v.columns).toHaveLength(fields.length);
      // and every field aggregated as its type allows
      const { id: agg } = await saveReport.run(admin, {
        name: `${source} grouped`,
        source,
        columns: [
          { field: fields[0]!.key },
          ...fields.slice(1).map((f) => ({
            field: f.key,
            aggregate:
              f.type === 'number'
                ? 'avg'
                : f.type === 'boolean'
                  ? 'countTrue'
                  : f.type === 'date'
                    ? 'max'
                    : 'countDistinct',
          })),
        ],
      });
      await viewReport(admin, agg, {});
    }
  });

  it('filters, groups and sorts participants; only its audience sees it', async () => {
    const f = await courseFixture(t.db, 'REP1');
    const admin = await ctxFor(t.db, 'admin@test.local');
    const student = await ctxFor(t.db, f.users.student1!);
    const page = await f.addActivity(
      'page',
      'Итог',
      { content: '<p>x</p>' },
      {
        completionMode: 'MANUAL',
      },
    );
    await toggleManualCompletion.run(student, { activityId: page.id, done: true });

    const { id } = await saveReport.run(admin, {
      name: 'Участники REP1',
      source: 'participants',
      columns: [
        { field: 'user.fullName' },
        { field: 'completion.progress' },
        { field: 'completion.completed' },
        { field: 'enrolment.status' },
      ],
      conditions: [{ field: 'course.shortName', op: 'equals', value: 'rep1' }],
      filters: ['user.fullName', 'completion.completed'],
      sort: { column: 1, desc: true },
    });
    const all = await viewReport(admin, id, {});
    expect(all.total).toBe(4);
    // the one who completed first
    expect(all.rows[0]).toEqual(['Иван Петров', 100, true, 'ACTIVE']);
    const done = await viewReport(admin, id, {
      filters: { 'completion.completed': { op: 'isTrue' } },
    });
    expect(done.rows.map((r) => r[0])).toEqual(['Иван Петров']);
    const named = await viewReport(admin, id, {
      filters: { 'user.fullName': { op: 'contains', value: 'мари' } },
    });
    expect(named.rows.map((r) => r[0])).toEqual(['Мария Сидорова']);

    // grouped by course: how many and how far
    const { id: grouped } = await saveReport.run(admin, {
      name: 'По курсам',
      source: 'participants',
      columns: [
        { field: 'course.shortName' },
        { field: 'user.fullName', aggregate: 'count' },
        { field: 'completion.completed', aggregate: 'countTrue' },
        { field: 'completion.progress', aggregate: 'avg' },
      ],
      conditions: [{ field: 'course.shortName', op: 'startsWith', value: 'REP' }],
    });
    expect((await viewReport(admin, grouped, {})).rows).toEqual([['REP1', 4, 1, 25]]);

    // bad definitions are refused
    await expect(
      saveReport.run(admin, {
        name: 'x',
        source: 'participants',
        columns: [{ field: 'user.fullName', aggregate: 'sum' }],
      }),
    ).rejects.toMatchObject({
      fieldErrors: { columns: [expect.stringMatching(/does not apply/)] },
    });
    await expect(
      saveReport.run(admin, { name: 'x', source: 'users', columns: [{ field: 'grade.grade' }] }),
    ).rejects.toMatchObject({ fieldErrors: { columns: [expect.stringMatching(/Unknown field/)] } });

    // the audience
    await expect(viewReport(student, id, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listReports(student)).reports).toHaveLength(0);
    await saveReport.run(admin, {
      id,
      name: 'Участники REP1',
      audiences: { userIds: [f.users.student1!] },
    });
    expect((await listReports(student)).reports.map((r) => r.name)).toEqual(['Участники REP1']);
    expect((await viewReport(student, id, {})).total).toBe(4);

    // downloads
    const csv = await exportReport(admin, id, 'csv');
    expect(csv.data.toString('utf8')).toContain('Иван Петров');
    const xlsx = await exportReport(admin, id, 'xlsx');
    const rows = readSheet(new Uint8Array(xlsx.data));
    expect(rows[0]).toHaveLength(4);
    expect(rows).toHaveLength(5);
  });

  it('emails reports on their schedules', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id } = await saveReport.run(admin, {
      name: 'Пользователи',
      source: 'users',
      columns: [{ field: 'user.fullName' }, { field: 'user.email' }],
    });
    const { id: empty } = await saveReport.run(admin, {
      name: 'Никого',
      source: 'users',
      columns: [{ field: 'user.fullName' }],
      conditions: [{ field: 'user.fullName', op: 'equals', value: 'нет такого' }],
    });
    const manager = await t.db.user.findFirstOrThrow({ where: { username: 'manager' } });
    const s = await saveSchedule.run(admin, {
      reportId: id,
      name: 'Каждый понедельник',
      frequency: 'WEEKLY',
      day: 1,
      hour: 9,
      userIds: [manager.id],
    });
    const skipped = await saveSchedule.run(admin, {
      reportId: empty,
      name: 'Пусто',
      frequency: 'DAILY',
      userIds: [manager.id],
    });
    sentMail.length = 0;
    expect(await sendSchedule(t.db, s.id)).toBe(1);
    expect(sentMail[0]).toMatchObject({ to: manager.email });
    expect(sentMail[0]!.attachments![0]!.filename).toBe('Пользователи.xlsx');
    expect(await sendSchedule(t.db, skipped.id)).toBe(0);
    // due ones only
    await t.db.reportSchedule.updateMany({ data: { nextRunAt: new Date(Date.now() + 3_600_000) } });
    expect(await runDueSchedules(t.db)).toBe(0);
    await t.db.reportSchedule.update({ where: { id: s.id }, data: { nextRunAt: new Date(0) } });
    expect(await runDueSchedules(t.db)).toBe(1);
    expect(
      (await t.db.reportSchedule.findUniqueOrThrow({ where: { id: s.id } })).nextRunAt > new Date(),
    ).toBe(true);
  });

  it('forgets a person who is erased', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const student = await t.db.user.findFirstOrThrow({ where: { username: 'student2' } });
    const { id } = await saveReport.run(admin, {
      name: 'Для удаления',
      source: 'users',
      columns: [{ field: 'user.fullName' }],
      audiences: { userIds: [student.id] },
    });
    const s = await saveSchedule.run(admin, { reportId: id, name: 'x', userIds: [student.id] });
    await deleteUser.run(admin, { id: student.id });
    const r = await t.db.customReport.findUniqueOrThrow({ where: { id } });
    expect((r.audiences as { userIds: string[] }).userIds).toEqual([]);
    expect((await t.db.reportSchedule.findUniqueOrThrow({ where: { id: s.id } })).userIds).toEqual(
      [],
    );
  });

  it('works out the next run in the site time zone', () => {
    // Thursday 15 October 2026, 10:00 in Moscow (07:00 UTC)
    const now = new Date('2026-10-15T07:00:00Z');
    const tz = 'Europe/Moscow';
    expect(nextRunAt({ frequency: 'DAILY', hour: 9, day: 1 }, tz, now).toISOString()).toBe(
      '2026-10-16T06:00:00.000Z',
    );
    expect(nextRunAt({ frequency: 'DAILY', hour: 11, day: 1 }, tz, now).toISOString()).toBe(
      '2026-10-15T08:00:00.000Z',
    );
    expect(nextRunAt({ frequency: 'WEEKLY', hour: 9, day: 1 }, tz, now).toISOString()).toBe(
      '2026-10-19T06:00:00.000Z',
    );
    expect(
      nextRunAt(
        { frequency: 'WEEKDAYS', hour: 9, day: 1 },
        tz,
        new Date('2026-10-16T07:00:00Z'),
      ).toISOString(),
    ).toBe('2026-10-19T06:00:00.000Z');
    expect(nextRunAt({ frequency: 'MONTHLY', hour: 8, day: 1 }, tz, now).toISOString()).toBe(
      '2026-11-01T05:00:00.000Z',
    );
  });
});
