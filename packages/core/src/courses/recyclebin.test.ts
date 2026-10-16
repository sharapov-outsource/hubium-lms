import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import type { MutationContext, RequestContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { setSettings } from '../settings/settings.ts';
import { deleteActivity, purgeActivity } from './activities.ts';
import { createCourse, deleteCourse, purgeCourse, restoreCourse } from './courses.ts';
import { purgeCommitted, purgeRecycleBin } from './recyclebin.ts';

describe('recycle bin', () => {
  const t = useTestDb();

  it('deletes a course for good, by hand or after its days, and frees its short name', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const f = await courseFixture(t.db, 'BIN-1');
    const { id: page } = await f.addActivity('page', 'Страница', { content: '<p>x</p>' });
    const category = (await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } }))
      .categoryId;
    await t.db.questionCategory.create({
      data: { contextId: f.courseId, name: 'Банк курса', sortOrder: 0 },
    });

    // only from the bin
    await expect(purgeCourse.run(admin, { id: f.courseId })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await deleteCourse.run(admin, { id: f.courseId });
    // the name is taken while it is there, and the person is told where
    await expect(
      createCourse.run(admin, { categoryId: category, fullName: 'Снова', shortName: 'bin-1' }),
    ).rejects.toMatchObject({
      fieldErrors: { shortName: [expect.stringMatching(/recycle bin/)] },
    });
    await restoreCourse.run(admin, { id: f.courseId });
    await deleteCourse.run(admin, { id: f.courseId });
    await purgeCourse.run(admin, { id: f.courseId });
    expect(await t.db.course.findUnique({ where: { id: f.courseId } })).toBeNull();
    expect(await t.db.activity.findUnique({ where: { id: page } })).toBeNull();
    expect(await t.db.context.findUnique({ where: { id: f.courseId } })).toBeNull();
    expect(await t.db.questionCategory.count({ where: { contextId: f.courseId } })).toBe(0);
    await createCourse.run(admin, { categoryId: category, fullName: 'Снова', shortName: 'BIN-1' });

    // the site keeps the bin for its days: older courses and activities go
    const g = await courseFixture(t.db, 'BIN-2');
    const { id: old } = await g.addActivity('page', 'Старая', { content: '<p>y</p>' });
    const { id: fresh } = await g.addActivity('page', 'Свежая', { content: '<p>z</p>' });
    await deleteActivity.run(admin, { id: old });
    await deleteActivity.run(admin, { id: fresh });
    const h = await courseFixture(t.db, 'BIN-3');
    await deleteCourse.run(admin, { id: h.courseId });
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    await t.db.activity.update({ where: { id: old }, data: { deletedAt: daysAgo(31) } });
    await t.db.course.update({ where: { id: h.courseId }, data: { deletedAt: daysAgo(40) } });
    await setSettings(t.db, { 'recyclebin.days': 0 });
    expect(await purgeRecycleBin(t.db, now)).toEqual({ courses: 0, activities: 0 });
    await setSettings(t.db, { 'recyclebin.days': 30 });
    expect(await purgeRecycleBin(t.db, now)).toEqual({ courses: 1, activities: 1 });
    expect(await t.db.course.findUnique({ where: { id: h.courseId } })).toBeNull();
    expect(await t.db.activity.findUnique({ where: { id: old } })).toBeNull();
    expect(await t.db.activity.findUnique({ where: { id: fresh } })).not.toBeNull();
  });

  it('deletes the stored objects of a purge only once it has committed', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const deleted: string[] = [];
    // what a module's storage.delete does in a purge
    const deleteLater = (cx: RequestContext, key: string) =>
      (cx as Partial<MutationContext>).afterCommit?.(() => {
        deleted.push(key);
      });
    await expect(
      purgeCommitted(ctx, async (cx) => {
        deleteLater(cx, 'rolled back');
        throw new Error('the purge fails');
      }),
    ).rejects.toThrow('the purge fails');
    await purgeCommitted(ctx, async (cx) => deleteLater(cx, 'committed'));
    expect(deleted).toEqual(['committed']);
  });

  it('takes the calendar events of an activity or a group deleted for good', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const f = await courseFixture(t.db, 'BIN-CAL');
    const { id: page } = await f.addActivity('page', 'Со сроком', { content: '<p>x</p>' });
    const group = await t.db.group.create({ data: { courseId: f.courseId, name: 'Г' } });
    const event = (data: { activityId?: string; groupId?: string }) =>
      t.db.calendarEvent.create({
        data: {
          scope: 'COURSE',
          courseId: f.courseId,
          title: 'Срок',
          startsAt: new Date(),
          ...data,
        },
      });
    await deleteActivity.run(admin, { id: page });
    const ofActivity = await event({ activityId: page });
    const ofGroup = await event({ groupId: group.id });
    await purgeActivity.run(admin, { id: page });
    await t.db.group.delete({ where: { id: group.id } });
    expect(await t.db.calendarEvent.findUnique({ where: { id: ofActivity.id } })).toBeNull();
    expect(await t.db.calendarEvent.findUnique({ where: { id: ofGroup.id } })).toBeNull();
  });
});
