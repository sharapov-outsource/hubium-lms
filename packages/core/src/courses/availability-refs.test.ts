import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { deleteGroup, deleteGrouping } from '../groups/groups.ts';
import { deleteActivity, getActivityAccess, purgeActivity, restoreActivity } from './activities.ts';

describe('restrictions on what is deleted', () => {
  const t = useTestDb();

  it('a condition on a deleted activity, group or grouping no longer locks anything', async () => {
    const f = await courseFixture(t.db, 'AVREF');
    const first = await f.addActivity(
      'page',
      'Вводная',
      { content: '<p>Текст</p>' },
      { completionMode: 'MANUAL' },
    );
    const after = { op: '&', c: [{ type: 'completion', activityId: first.id, state: 'complete' }] };
    const next = await f.addActivity(
      'page',
      'После вводной',
      { content: '<p>Текст</p>' },
      { availability: after },
    );
    const section = await t.db.courseSection.findFirstOrThrow({
      where: { courseId: f.courseId },
      orderBy: { rank: 'desc' },
    });
    await t.db.courseSection.update({ where: { id: section.id }, data: { availability: after } });
    const admin = await ctxFor(t.db, 'admin@test.local');
    const opens = async (id: string) =>
      (await getActivityAccess(await ctxFor(t.db, f.users.student1!), id)).canOpen;
    expect(await opens(next.id)).toBe(false);

    // in the recycle bin the condition does not apply; restored, it does again
    await deleteActivity.run(admin, { id: first.id });
    expect(await opens(next.id)).toBe(true);
    await restoreActivity.run(admin, { id: first.id });
    expect(await opens(next.id)).toBe(false);

    // deleted for good, it is taken out of the restrictions
    await deleteActivity.run(admin, { id: first.id });
    await purgeActivity.run(admin, { id: first.id });
    const stored = async () => ({
      activity: (await t.db.activity.findUniqueOrThrow({ where: { id: next.id } })).availability,
      section: (await t.db.courseSection.findUniqueOrThrow({ where: { id: section.id } }))
        .availability,
    });
    expect(await stored()).toEqual({ activity: null, section: null });

    // a group and a grouping, deleted
    const group = await t.db.group.create({ data: { courseId: f.courseId, name: 'Группа А' } });
    const grouping = await t.db.grouping.create({
      data: { courseId: f.courseId, name: 'Поток 1' },
    });
    const both = {
      op: '|',
      c: [
        { type: 'group', groupId: group.id },
        { type: 'grouping', groupingId: grouping.id },
        { type: 'date', op: '>=', at: '2099-01-01T00:00:00Z' },
      ],
    };
    await t.db.activity.update({ where: { id: next.id }, data: { availability: both } });
    expect(await opens(next.id)).toBe(false);
    await deleteGroup.run(admin, { id: group.id });
    await deleteGrouping.run(admin, { id: grouping.id });
    expect((await stored()).activity).toEqual({ op: '|', c: [both.c[2]] });
  });
});
