import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { createGroup, setGroupMembers } from '../groups/groups.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

type Saved = { pageId: string; version: number };
type Lock = { locked: boolean; by: string | null };

describe('mod-wiki', () => {
  const t = useTestDb();

  it('pages, links, versions, restoring, and the lock while someone edits', async () => {
    const f = await courseFixture(t.db, 'WIKI1');
    const name = async (id: string) => (await t.db.user.findUniqueOrThrow({ where: { id } })).name;
    const { id } = await f.addActivity('wiki', 'Вики курса', { firstPageTitle: 'Главная' });
    const [teacher, s1, s2] = await Promise.all(
      [f.users.teacher!, f.users.student1!, f.users.student2!].map((u) => ctxFor(t.db, u)),
    );
    // the first page is not written yet
    await expect(runModuleQuery(s1!, id, 'page', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const home = (await runModuleAction(s1!, id, 'save', {
      title: 'Главная',
      content: '<p>См. [[Циклы]] и [[Функции|функции]].</p>',
    })) as Saved;
    expect(home.version).toBe(1);
    await expect(
      runModuleAction(s2!, id, 'save', { title: ' Главная ', content: '<p>x</p>' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const loops = (await runModuleAction(s2!, id, 'save', {
      title: 'Циклы',
      content: '<p>for и while</p>',
    })) as Saved;
    await runModuleAction(s2!, id, 'save', { title: 'Черновик', content: '<p>...</p>' });
    const index = (await runModuleQuery(s1!, id, 'index', {})) as {
      pages: { title: string }[];
      orphans: string[];
    };
    expect(index.pages.map((p) => p.title)).toEqual(['Главная', 'Циклы', 'Черновик']);
    expect(index.orphans).toEqual(['Черновик']);

    // s1 opens the editor: s2 is locked out, a teacher may take over
    expect(await runModuleAction(s1!, id, 'lock', { pageId: loops.pageId })).toMatchObject({
      locked: true,
    });
    const other = (await runModuleAction(s2!, id, 'lock', { pageId: loops.pageId })) as Lock;
    expect(other).toMatchObject({ locked: false, by: await name(f.users.student1!) });
    await expect(
      runModuleAction(s2!, id, 'save', { pageId: loops.pageId, content: '<p>mine</p>' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // a learner cannot take over; a teacher can
    expect(
      ((await runModuleAction(s2!, id, 'lock', { pageId: loops.pageId, force: true })) as Lock)
        .locked,
    ).toBe(false);
    expect(
      ((await runModuleAction(teacher!, id, 'lock', { pageId: loops.pageId, force: true })) as Lock)
        .locked,
    ).toBe(true);
    await runModuleAction(teacher!, id, 'unlock', { pageId: loops.pageId });

    // saving over a version someone else changed meanwhile is refused
    await runModuleAction(s1!, id, 'save', {
      pageId: loops.pageId,
      baseVersion: 1,
      content: '<p>for, while и do</p>',
    });
    await expect(
      runModuleAction(s2!, id, 'save', {
        pageId: loops.pageId,
        baseVersion: 1,
        content: '<p>старое</p>',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // history and restoring
    const history = (await runModuleQuery(s1!, id, 'history', { pageId: loops.pageId })) as {
      version: number;
      author: { name: string } | null;
    }[];
    expect(history.map((v) => [v.version, v.author?.name])).toEqual([
      [2, await name(f.users.student1!)],
      [1, await name(f.users.student2!)],
    ]);
    await runModuleAction(s2!, id, 'restore', { pageId: loops.pageId, version: 1 });
    expect(await runModuleQuery(s1!, id, 'page', { pageId: loops.pageId })).toMatchObject({
      version: 3,
      content: '<p>for и while</p>',
    });
    // only managers delete pages
    await expect(
      runModuleAction(s1!, id, 'deletePage', { pageId: loops.pageId }),
    ).rejects.toThrow();
    await runModuleAction(teacher!, id, 'deletePage', { pageId: loops.pageId });
  });

  it('a wiki for each group, and a learner’s own wiki', async () => {
    const f = await courseFixture(t.db, 'WIKI2');
    const [teacher, s1, s2] = await Promise.all(
      [f.users.teacher!, f.users.student1!, f.users.student2!].map((u) => ctxFor(t.db, u)),
    );
    const { id } = await f.addActivity(
      'wiki',
      'Групповая',
      { firstPageTitle: 'Старт' },
      { groupMode: 'SEPARATE' },
    );
    const a = await createGroup.run(teacher!, { courseId: f.courseId, name: 'А' });
    await setGroupMembers.run(teacher!, { groupId: a.id, add: [f.users.student1!] });
    const b = await createGroup.run(teacher!, { courseId: f.courseId, name: 'Б' });
    await setGroupMembers.run(teacher!, { groupId: b.id, add: [f.users.student2!] });
    await runModuleAction(s1!, id, 'save', { title: 'Старт', content: '<p>Группа А</p>' });
    await runModuleAction(s2!, id, 'save', { title: 'Старт', content: '<p>Группа Б</p>' });
    // each sees their group's page; asking for another group's gives their own
    expect(await runModuleQuery(s1!, id, 'page', {})).toMatchObject({ content: '<p>Группа А</p>' });
    expect(await runModuleQuery(s1!, id, 'page', { groupId: b.id })).toMatchObject({
      content: '<p>Группа А</p>',
    });
    expect(await runModuleQuery(teacher!, id, 'page', { groupId: b.id })).toMatchObject({
      content: '<p>Группа Б</p>',
    });

    const own = await f.addActivity('wiki', 'Дневник', { mode: 'individual', firstPageTitle: 'Я' });
    const mine = (await runModuleAction(s1!, own.id, 'save', {
      title: 'Я',
      content: '<p>Мой дневник</p>',
    })) as Saved;
    await expect(runModuleQuery(s2!, own.id, 'page', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      runModuleQuery(s2!, own.id, 'page', { userId: f.users.student1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      runModuleAction(s2!, own.id, 'lock', { pageId: mine.pageId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await runModuleQuery(teacher!, own.id, 'page', { userId: f.users.student1 }),
    ).toMatchObject({ content: '<p>Мой дневник</p>' });
  });
});
