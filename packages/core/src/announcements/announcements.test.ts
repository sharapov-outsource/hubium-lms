import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError } from '../errors.ts';
import { createGroup, setGroupMembers } from '../groups/groups.ts';
import {
  createAnnouncement,
  deleteAnnouncement,
  listCourseAnnouncements,
  listSiteAnnouncements,
  pinAnnouncement,
  publishDueAnnouncements,
  recentCourseAnnouncements,
  updateAnnouncement,
} from './announcements.ts';

describe('announcements', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'ANN1');
  });

  const count = (userId: string, type: string) =>
    t.db.notification.count({ where: { userId, type } });

  it('teacher posts to the course stream and students are notified', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await createAnnouncement.run(teacher, {
      courseId: f.courseId,
      title: 'Добро пожаловать',
      contentHtml: '<p>Начинаем в понедельник</p><script>x</script>',
    });
    const s1 = await ctxFor(t.db, f.users.student1!);
    const { items, canPost } = await listCourseAnnouncements(s1, f.courseId);
    expect(canPost).toBe(false);
    expect(items[0]).toMatchObject({ title: 'Добро пожаловать' });
    expect(items[0]?.contentHtml).toBe('<p>Начинаем в понедельник</p>');
    expect(await count(f.users.student1!, 'announcement.course')).toBe(1);
    expect(await count(f.users.teacher!, 'announcement.course')).toBe(0);
    const n = await t.db.notification.findFirstOrThrow({
      where: { userId: f.users.student1, type: 'announcement.course' },
    });
    expect(n.title).toBe('ANN1: Добро пожаловать');
    expect(n.body).toBe('Начинаем в понедельник');
  });

  it('students cannot post', async () => {
    const s1 = await ctxFor(t.db, f.users.student1!);
    await expect(
      createAnnouncement.run(s1, { courseId: f.courseId, title: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('scheduled announcements stay hidden until published by the cron', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const at = new Date(Date.now() + 3600_000);
    const { id } = await createAnnouncement.run(teacher, {
      courseId: f.courseId,
      title: 'Позже',
      publishAt: at.toISOString(),
    });
    const s2 = await ctxFor(t.db, f.users.student2!);
    expect((await listCourseAnnouncements(s2, f.courseId)).items.map((a) => a.id)).not.toContain(
      id,
    );
    expect((await listCourseAnnouncements(teacher, f.courseId)).items.map((a) => a.id)).toContain(
      id,
    );
    expect(await publishDueAnnouncements(t.db, new Date())).toBe(0);
    expect(await publishDueAnnouncements(t.db, new Date(at.getTime() + 1000))).toBe(1);
    expect(await publishDueAnnouncements(t.db, new Date(at.getTime() + 2000))).toBe(0);
    expect(await count(f.users.student2!, 'announcement.course')).toBe(2);
    // editing after publication does not notify again
    await updateAnnouncement.run(teacher, { id, title: 'Позже (исправлено)' });
    expect(await count(f.users.student2!, 'announcement.course')).toBe(2);
  });

  it('group announcements reach only that group', async () => {
    const sys = await ctxFor(t.db, 'system');
    const { id: groupId } = await createGroup.run(sys, { courseId: f.courseId, name: 'G1' });
    await setGroupMembers.run(sys, { groupId, add: [f.users.student3!] });
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id } = await createAnnouncement.run(teacher, {
      courseId: f.courseId,
      groupId,
      title: 'Только G1',
    });
    const s1 = await ctxFor(t.db, f.users.student1!);
    const s3 = await ctxFor(t.db, f.users.student3!);
    expect((await listCourseAnnouncements(s1, f.courseId)).items.map((a) => a.id)).not.toContain(
      id,
    );
    expect((await listCourseAnnouncements(s3, f.courseId)).items.map((a) => a.id)).toContain(id);
    expect(
      (await recentCourseAnnouncements(t.db, f.users.student3!, [f.courseId])).map((a) => a.id),
    ).toContain(id);
    expect(await count(f.users.student1!, 'announcement.course')).toBe(2);
    expect(await count(f.users.student3!, 'announcement.course')).toBe(3);
    await deleteAnnouncement.run(teacher, { id });
    expect(await t.db.announcement.count({ where: { id } })).toBe(0);
  });

  it('site announcements need site:config and reach everyone', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await expect(createAnnouncement.run(teacher, { title: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const admin = await ctxFor(t.db, 'admin@test.local');
    await createAnnouncement.run(admin, { title: 'Профилактика', pinned: true });
    expect((await listSiteAnnouncements(t.db))[0]?.title).toBe('Профилактика');
    const active = await t.db.user.count({ where: { status: 'ACTIVE', kind: 'PERSON' } });
    expect(await t.db.notification.count({ where: { type: 'announcement.site' } })).toBe(
      active - 1,
    );
  });

  it('pages the course stream, the pinned items heading the first page', async () => {
    const g = await courseFixture(t.db, 'ANN-PAGE');
    const teacher = await ctxFor(t.db, g.users.teacher!);
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++)
      ids.push(
        (
          await createAnnouncement.run(teacher, {
            courseId: g.courseId,
            title: `Новость ${n}`,
            contentHtml: '<p>Текст</p>',
          })
        ).id,
      );
    await pinAnnouncement.run(teacher, { id: ids[0]!, pinned: true });
    const s1 = await ctxFor(t.db, g.users.student1!);
    const first = await listCourseAnnouncements(s1, g.courseId, { limit: 2 });
    expect(first.items.map((a) => a.title)).toEqual(['Новость 1', 'Новость 5', 'Новость 4']);
    const second = await listCourseAnnouncements(s1, g.courseId, {
      limit: 2,
      before: first.next!,
    });
    expect(second.items.map((a) => a.title)).toEqual(['Новость 3', 'Новость 2']);
    expect(second.next).toBeNull();
  });
});
