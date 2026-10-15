import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

type Toc = { id: string; number: string; title: string; subchapter: boolean; hidden: boolean }[];

describe('mod-book', () => {
  const t = useTestDb();

  it('keeps chapters in order, hides them from learners and deletes them with subchapters', async () => {
    const f = await courseFixture(t.db, 'BOOK1');
    const { id } = await f.addActivity('book', 'Учебник', { numbering: 'numbers' });
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const student = await ctxFor(t.db, f.users.student1!);
    const add = async (title: string, extra: object = {}) =>
      (
        (await runModuleAction(teacher, id, 'addChapter', {
          title,
          content: `<p>${title}</p><script>alert(1)</script>`,
          ...extra,
        })) as { id: string }
      ).id;

    const intro = await add('Введение', { subchapter: true });
    const syntax = await add('Синтаксис');
    // a subchapter after the first chapter; a chapter after it goes after its subchapters
    const history = await add('История', { afterId: intro, subchapter: true });
    await add('Установка', { afterId: intro });
    const toc = async (who = teacher) => (await runModuleQuery(who, id, 'chapters', {})) as Toc;
    expect((await toc()).map((c) => `${c.number} ${c.title}`)).toEqual([
      '1 Введение',
      '1.1 История',
      '2 Установка',
      '3 Синтаксис',
    ]);
    // the first row cannot be a subchapter; content is cleaned
    const chapter = (await runModuleQuery(teacher, id, 'chapter', { id: intro })) as {
      subchapter: boolean;
      content: string;
    };
    expect(chapter).toMatchObject({ subchapter: false, content: '<p>Введение</p>' });

    await runModuleAction(teacher, id, 'moveChapter', { id: syntax, direction: 'up' });
    await runModuleAction(teacher, id, 'setChapterHidden', { id: intro, hidden: true });
    expect((await toc(student)).map((c) => c.title)).toEqual(['Синтаксис', 'Установка']);
    await expect(runModuleQuery(student, id, 'chapter', { id: history })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      runModuleAction(student, id, 'addChapter', { title: 'Чужая' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const r = (await runModuleAction(teacher, id, 'deleteChapter', { id: intro })) as {
      deleted: number;
    };
    expect(r.deleted).toBe(2);
    expect((await toc()).map((c) => `${c.number} ${c.title}`)).toEqual([
      '1 Синтаксис',
      '2 Установка',
    ]);
  });
});
