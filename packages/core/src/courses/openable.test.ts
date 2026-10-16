import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { getActivityAccess, openableActivityIds } from './activities.ts';

describe('activities a viewer may open', () => {
  const t = useTestDb();

  it('decides many at once as it decides each', async () => {
    const f = await courseFixture(t.db, 'OPENMANY');
    const page = (name: string, extra: Record<string, unknown> = {}) =>
      f.addActivity('page', name, { content: '<p>x</p>' }, extra);
    const shown = await page('Открытая');
    const hidden = await page('Скрытая', { visibility: 'HIDDEN' });
    const stealth = await page('По ссылке', { visibility: 'STEALTH' });
    const later = await page('Позже');
    await t.db.activity.update({
      where: { id: later.id },
      data: {
        availability: {
          op: '&',
          showc: [true],
          c: [{ type: 'date', op: '>=', at: '2099-01-01T00:00:00Z' }],
        },
      },
    });
    const gone = await page('Удалённая');
    await t.db.activity.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const all = await t.db.activity.findMany({ where: { courseId: f.courseId } });
    for (const user of [f.users.student1!, f.users.teacher!]) {
      const ctx = await ctxFor(t.db, user);
      const each = new Set<string>();
      for (const a of all) if ((await getActivityAccess(ctx, a.id)).canOpen) each.add(a.id);
      expect(await openableActivityIds(ctx, f.courseId, all)).toEqual(each);
    }
    // what a learner opens: the shown one and the one opened by its link
    const learner = await openableActivityIds(
      await ctxFor(t.db, f.users.student1!),
      f.courseId,
      all,
    );
    expect([...learner].sort()).toEqual([shown.id, stealth.id].sort());
    expect(learner.has(hidden.id) || learner.has(later.id) || learner.has(gone.id)).toBe(false);
  });
});
