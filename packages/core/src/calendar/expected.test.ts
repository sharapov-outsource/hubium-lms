import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { toggleManualCompletion } from '../completion/completion.ts';
import { updateActivity } from '../courses/activities.ts';
import { collectTodo } from '../dashboard/todo.ts';
import { listUserEvents } from './calendar.ts';

describe('an expected completion date', () => {
  const t = useTestDb();

  it('is in the calendar and to do for learners until they complete the activity', async () => {
    const f = await courseFixture(t.db, 'EXPCAL');
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const { id } = await f.addActivity(
      'page',
      'Чтение',
      { content: '<p>Глава 1</p>' },
      { completionMode: 'MANUAL', completionExpectedAt: day },
    );
    const event = await t.db.calendarEvent.findFirstOrThrow({
      where: { activityId: id, kind: 'EXPECTED' },
    });
    // a date, the same in every time zone
    expect(event.allDay).toBe(true);
    expect(event.startsAt.toISOString()).toBe(`${day}T00:00:00.000Z`);

    const range = { from: new Date(), to: new Date(Date.now() + 10 * 86_400_000) };
    const expected = async (userId: string) =>
      (await listUserEvents(t.db, userId, range))
        .filter((e) => e.kind === 'EXPECTED')
        .map((e) => e.activityId);
    const student = f.users.student1!;
    expect(await expected(student)).toEqual([id]);
    // not the teacher's to complete
    expect(await expected(f.users.teacher!)).toEqual([]);
    const ctx = await ctxFor(t.db, student);
    expect((await collectTodo(ctx, student)).filter((i) => i.kind === 'complete')).toMatchObject([
      { activityId: id, courseId: f.courseId, allDay: true },
    ]);

    await toggleManualCompletion.run(ctx, { activityId: id, done: true });
    expect(await expected(student)).toEqual([]);
    expect((await collectTodo(ctx, student)).filter((i) => i.kind === 'complete')).toEqual([]);
    expect(await expected(f.users.student2!)).toEqual([id]);

    // without completion tracking there is nothing to expect
    await updateActivity.run(await ctxFor(t.db, 'system'), {
      id,
      name: 'Чтение',
      completionMode: 'NONE',
      completionExpectedAt: day,
      settings: { content: '<p>Глава 1</p>' },
    });
    expect(await t.db.calendarEvent.count({ where: { activityId: id } })).toBe(0);
  });
});
