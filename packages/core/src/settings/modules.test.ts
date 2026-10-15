import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { listUserEvents } from '../calendar/calendar.ts';
import {
  createActivity,
  getActivityAccess,
  getCourseOutline,
  importActivity,
  updateActivity,
} from '../courses/activities.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { runModuleAction } from '../modules/actions.ts';
import { buildModuleCtx } from '../modules/module-ctx.ts';
import { enabledModules, isModuleEnabled, moduleOverview, saveModuleSettings } from './modules.ts';
import { getAllSettings, setSettings } from './settings.ts';

describe('turning activity types off', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let forumId: string;
  let assignId: string;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'MODOFF');
    forumId = (await f.addActivity('forum', 'Forum', { subscription: 'auto' })).id;
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    assignId = (
      await f.addActivity(
        'assign',
        'Essay',
        { dueAt: due, gradeMax: 10 },
        { completionMode: 'AUTO', completionRules: { module: { submit: true } } },
      )
    ).id;
  });

  const as = (id: string) => ctxFor(t.db, id);
  const outlineOf = async (userId: string) =>
    (await getCourseOutline(await as(userId), f.courseId)).flatMap((s) => s.activities);

  it('rejects unknown types, keeps the content types on and needs site:config', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await expect(saveModuleSettings.run(admin, { enabled: ['nope'] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      saveModuleSettings.run(await as(f.users.teacher!), { enabled: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    try {
      const { disabled } = await saveModuleSettings.run(admin, { enabled: [] });
      expect(disabled).not.toContain('page');
      expect(disabled).toContain('forum');
      const s = await getAllSettings(t.db);
      for (const key of ['page', 'url', 'label', 'file'])
        expect(isModuleEnabled(s, key)).toBe(true);
      expect((await enabledModules(t.db)).map((m) => m.key).sort()).toEqual([
        'file',
        'label',
        'page',
        'url',
      ]);
    } finally {
      await setSettings(t.db, { 'modules.disabled': [] });
    }
  });

  it('hides the activities from learners and keeps their data', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await saveModuleSettings.run(admin, {
      enabled: (await moduleOverview(admin))
        .map((m) => m.key)
        .filter((k) => k !== 'forum' && k !== 'assign'),
    });
    try {
      const overview = await moduleOverview(admin);
      expect(overview.find((m) => m.key === 'assign')).toMatchObject({
        enabled: false,
        activities: 1,
        courses: 1,
        tracked: 1,
      });

      // learners lose them; editors see them, unopenable
      const student = await outlineOf(f.users.student1!);
      expect(student.map((a) => a.activity.id)).not.toContain(forumId);
      const teacher = await outlineOf(f.users.teacher!);
      expect(teacher.find((a) => a.activity.id === forumId)).toMatchObject({
        listed: true,
        available: false,
        moduleDisabled: true,
      });
      for (const user of [f.users.teacher!, f.users.student1!]) {
        const access = await getActivityAccess(await as(user), forumId);
        expect(access).toMatchObject({ canOpen: false, moduleDisabled: true });
      }

      // nothing new happens in them
      await expect(
        runModuleAction(await as(f.users.student1!), forumId, 'startDiscussion', {
          title: 'Hi',
          message: '<p>Hi</p>',
        }),
      ).rejects.toThrow('turned off');
      const teacher1 = await as(f.users.teacher!);
      const section = await t.db.courseSection.findFirstOrThrow({
        where: { courseId: f.courseId },
      });
      const input = {
        courseId: f.courseId,
        sectionId: section.id,
        moduleKey: 'forum',
        name: 'Another forum',
        settings: {},
      };
      await expect(createActivity.run(teacher1, input)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        updateActivity.run(teacher1, { id: forumId, name: 'Renamed', settings: {} }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      // restores and imports keep them
      const imported = await importActivity.run(teacher1, input);
      expect(await t.db.activity.count({ where: { id: imported.id } })).toBe(1);

      // the deadline leaves the calendar, the notification is not sent, the grade item stays
      const events = await listUserEvents(t.db, f.users.student1!, {
        from: new Date(),
        to: new Date(Date.now() + 30 * 86_400_000),
        courseId: f.courseId,
      });
      expect(events.some((e) => e.activityId === assignId)).toBe(false);
      await t.db.$transaction((tx) =>
        buildModuleCtx(teacher1, tx).notify.send([f.users.student1!], {
          type: 'forum.post',
          title: 'Post',
          url: '/',
        } as never),
      );
      expect(
        await t.db.notification.count({ where: { userId: f.users.student1, type: 'forum.post' } }),
      ).toBe(0);
      expect(await t.db.gradeItem.count({ where: { activityId: assignId } })).toBeGreaterThan(0);
    } finally {
      await setSettings(t.db, { 'modules.disabled': [] });
    }

    // turned on again, everything is back
    const student = await outlineOf(f.users.student1!);
    expect(student.find((a) => a.activity.id === forumId)?.available).toBe(true);
    const events = await listUserEvents(t.db, f.users.student1!, {
      from: new Date(),
      to: new Date(Date.now() + 30 * 86_400_000),
      courseId: f.courseId,
    });
    expect(events.some((e) => e.activityId === assignId)).toBe(true);
    await t.db.$transaction(async (tx) =>
      buildModuleCtx(await as(f.users.teacher!), tx).notify.send([f.users.student1!], {
        type: 'forum.post',
        title: 'Post',
        url: '/',
      } as never),
    );
    expect(
      await t.db.notification.count({ where: { userId: f.users.student1, type: 'forum.post' } }),
    ).toBe(1);
  });
});
