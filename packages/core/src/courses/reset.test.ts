import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { runModuleAction } from '../modules/actions.ts';
import { resetCourse, resetOverview, shiftIsoDates } from './reset.ts';

describe('shiftIsoDates', () => {
  it('moves date-times anywhere in a value and leaves other strings', () => {
    const day = 86_400_000;
    expect(
      shiftIsoDates(
        { dueAt: '2026-09-01T09:00:00.000Z', name: '2026', c: [{ at: '2026-09-02T00:00:00Z' }] },
        7 * day,
      ),
    ).toEqual({
      dueAt: '2026-09-08T09:00:00.000Z',
      name: '2026',
      c: [{ at: '2026-09-09T00:00:00.000Z' }],
    });
    expect(shiftIsoDates('2026-09-01', day)).toBe('2026-09-01');
  });
});

describe('course reset', () => {
  const t = useTestDb();

  it('clears the chosen learners data and moves the term', async () => {
    const f = await courseFixture(t.db, 'RESET1');
    const admin = await ctxFor(t.db, 'admin@test.local');
    await t.db.course.update({
      where: { id: f.courseId },
      data: {
        startDate: new Date('2026-09-01T00:00:00Z'),
        endDate: new Date('2026-12-31T00:00:00Z'),
      },
    });
    const { id: assignId } = await f.addActivity('assign', 'Эссе', {
      gradeMax: 10,
      dueAt: '2026-09-15T18:00:00.000Z',
    });
    const s1 = await ctxFor(t.db, f.users.student1!);
    await runModuleAction(s1, assignId, 'saveSubmission', { text: '<p>Работа</p>', submit: true });
    await runModuleAction(await ctxFor(t.db, f.users.teacher!), assignId, 'grade', {
      userId: f.users.student1,
      grade: 8,
    });
    expect(await t.db.assignSubmission.count({ where: { activityId: assignId } })).toBe(1);

    const overview = await resetOverview(admin, f.courseId);
    expect(overview.modules).toContainEqual({ key: 'assign', activities: 1 });
    expect(overview.grades).toBeGreaterThan(0);

    const report = await resetCourse.run(admin, {
      courseId: f.courseId,
      startDate: '2027-02-01',
      activityData: ['assign'],
      unenrolRoleIds: [f.roles.student!],
    });
    expect(report).toMatchObject({ activities: 1, unenrolled: 3, shiftedDays: 153 });
    expect(await t.db.assignSubmission.count({ where: { activityId: assignId } })).toBe(0);
    expect(await t.db.grade.count({ where: { item: { activityId: assignId } } })).toBe(0);
    // the teacher stays, the students go
    expect(await t.db.enrolment.count({ where: { courseId: f.courseId } })).toBe(1);

    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    expect(course.endDate?.toISOString()).toBe('2027-06-02T00:00:00.000Z');
    const a = await t.db.activity.findUniqueOrThrow({ where: { id: assignId } });
    expect((a.settings as { dueAt: string }).dueAt).toBe('2027-02-15T18:00:00.000Z');
    const ev = await t.db.calendarEvent.findFirst({ where: { activityId: assignId } });
    if (ev) expect(ev.startsAt.toISOString()).toBe('2027-02-15T18:00:00.000Z');
  });

  it('needs course:reset', async () => {
    const f = await courseFixture(t.db, 'RESET2');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await expect(
      resetCourse.run(teacher, { courseId: f.courseId, completion: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
