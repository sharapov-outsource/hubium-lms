import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import {
  recomputeActivityForAll,
  recomputeCourseProgress,
  toggleManualCompletion,
} from './completion.ts';

describe('completion rule changes', () => {
  const t = useTestDb();

  it('re-evaluates everyone when an activity switches to new automatic rules', async () => {
    const f = await courseFixture(t.db, 'COMPL1');
    const { id } = await f.addActivity(
      'page',
      'Правила',
      { content: '<p>Текст</p>' },
      { completionMode: 'MANUAL' },
    );
    const s1 = await ctxFor(t.db, f.users.student1!);
    await toggleManualCompletion.run(s1, { activityId: id, done: true });
    const state = async () =>
      (
        await t.db.activityCompletion.findUnique({
          where: { activityId_userId: { activityId: id, userId: f.users.student1! } },
        })
      )?.state;
    expect(await state()).toBe('COMPLETE');

    capturedJobs.length = 0;
    const admin = await ctxFor(t.db, 'admin@test.local');
    await updateActivity.run(admin, {
      id,
      name: 'Правила',
      settings: { content: '<p>Текст</p>' },
      completionMode: 'AUTO',
      completionRules: { view: true },
    });
    expect(capturedJobs).toContainEqual(
      expect.objectContaining({ name: 'completion.recompute', data: { activityId: id } }),
    );
    expect(await recomputeActivityForAll(t.db, id)).toBeGreaterThan(0);
    // the learner has not viewed the page, which is now required
    expect(await state()).toBe('INCOMPLETE');
  });

  it('takes a manual mark only on an activity the learner may open, while enrolled', async () => {
    const f = await courseFixture(t.db, 'COMPL2');
    const first = await f.addActivity(
      'page',
      'Экзамен',
      { content: '<p>Текст</p>' },
      { completionMode: 'MANUAL' },
    );
    const { id } = await f.addActivity(
      'page',
      'Рефлексия',
      { content: '<p>Текст</p>' },
      {
        completionMode: 'MANUAL',
        availability: {
          op: '&',
          c: [{ type: 'completion', activityId: first.id, state: 'complete' }],
        },
      },
    );
    const s1 = await ctxFor(t.db, f.users.student1!);
    const mark = () => toggleManualCompletion.run(s1, { activityId: id, done: true });
    await expect(mark()).rejects.toThrow(/open/);

    await toggleManualCompletion.run(s1, { activityId: first.id, done: true });
    await expect(mark()).resolves.toMatchObject({ percent: 100 });

    // hidden from learners
    await t.db.activity.update({ where: { id: first.id }, data: { visibility: 'HIDDEN' } });
    await expect(
      toggleManualCompletion.run(s1, { activityId: first.id, done: false }),
    ).rejects.toThrow(/open/);
    await t.db.activity.update({ where: { id: first.id }, data: { visibility: 'SHOWN' } });

    // an enrolment that has ended
    await t.db.enrolment.updateMany({
      where: { courseId: f.courseId, userId: f.users.student1! },
      data: { endsAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      toggleManualCompletion.run(await ctxFor(t.db, f.users.student1!), {
        activityId: first.id,
        done: false,
      }),
    ).rejects.toThrow(/enrolled/);
  });

  it('counts a failed activity towards neither progress nor completing the course', async () => {
    const f = await courseFixture(t.db, 'COMPL3');
    const page = await f.addActivity(
      'page',
      'Лекция',
      { content: '<p>Текст</p>' },
      { completionMode: 'MANUAL' },
    );
    const exam = await f.addActivity(
      'page',
      'Итоговый тест',
      { content: '<p>Текст</p>' },
      { completionMode: 'MANUAL' },
    );
    const s1 = await ctxFor(t.db, f.users.student1!);
    await toggleManualCompletion.run(s1, { activityId: page.id, done: true });
    // a pass mark not reached, as a quiz's "pass" rule gives
    await t.db.activityCompletion.create({
      data: { activityId: exam.id, userId: f.users.student1!, state: 'COMPLETE_FAIL' },
    });
    expect(await recomputeCourseProgress(t.db, f.courseId, f.users.student1!)).toBe(50);
    const row = await t.db.courseCompletion.findUniqueOrThrow({
      where: { courseId_userId: { courseId: f.courseId, userId: f.users.student1! } },
    });
    expect(row.completedAt).toBeNull();
    await t.db.activityCompletion.update({
      where: { activityId_userId: { activityId: exam.id, userId: f.users.student1! } },
      data: { state: 'COMPLETE_PASS' },
    });
    expect(await recomputeCourseProgress(t.db, f.courseId, f.users.student1!)).toBe(100);
  });
});
