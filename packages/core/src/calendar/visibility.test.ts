import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { listMyCourses } from '../courses/courses.ts';
import { createEvent, listUserEvents } from './calendar.ts';

describe('what is hidden stays out of my courses and the calendar', () => {
  const t = useTestDb();

  it('leaves out hidden courses, sections and activities, and restricted activities', async () => {
    const f = await courseFixture(t.db, 'HIDCAL');
    const admin = await ctxFor(t.db, 'admin@test.local');
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    const due = (name: string, n: number, extra: Record<string, unknown> = {}) =>
      f.addActivity('assign', name, { gradeMax: 10, dueAt: day(n) }, extra);
    await createEvent.run(admin, {
      scope: 'COURSE',
      courseId: f.courseId,
      title: 'Консультация',
      startsAt: new Date(day(2)),
    });
    await due('Открытое', 3);
    await due('Только после даты', 4, {
      availability: {
        op: '&',
        hidden: true,
        c: [{ type: 'date', op: '>=', at: day(30) }],
      },
    });
    const section = await t.db.courseSection.create({
      data: { courseId: f.courseId, rank: 'zz', title: 'Вариант Б', visible: false },
    });
    const inHidden = await due('Контрольная (вариант Б)', 5);
    await t.db.activity.update({ where: { id: inHidden.id }, data: { sectionId: section.id } });

    const range = { from: new Date(), to: new Date(Date.now() + 10 * 86_400_000) };
    const titles = async (userId: string) =>
      (await listUserEvents(t.db, userId, range))
        .filter((e) => e.courseId === f.courseId)
        .map((e) => e.title)
        .sort();
    const student = f.users.student1!;
    const all = await titles(f.users.teacher!);
    expect(all.length).toBe(4);
    const mine = await titles(student);
    expect(mine).toHaveLength(2);
    expect(mine.some((x) => x.includes('Открытое'))).toBe(true);
    expect(mine).toContain('Консультация');

    // a hidden course: neither in my courses nor in the calendar, for learners
    const mineCourses = async (userId: string) =>
      (await listMyCourses(t.db, userId)).map((c) => c.id);
    expect(await mineCourses(student)).toContain(f.courseId);
    await t.db.course.update({ where: { id: f.courseId }, data: { visible: false } });
    expect(await mineCourses(student)).not.toContain(f.courseId);
    expect(await titles(student)).toEqual([]);
    expect(await mineCourses(f.users.teacher!)).toContain(f.courseId);
    expect(await titles(f.users.teacher!)).toHaveLength(4);
  });
});
