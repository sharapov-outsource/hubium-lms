import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { recomputeActivityForAll, toggleManualCompletion } from './completion.ts';

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
});
