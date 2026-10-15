import type { dataRecords } from '@hubium/mod-data/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';
import { buildModuleCtx, toActivityRef } from './module-ctx.ts';
import { getModule } from './registry.ts';

type Page = Awaited<ReturnType<typeof dataRecords>>;
type Ctx = Awaited<ReturnType<typeof ctxFor>>;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('mod-data', () => {
  const t = useTestDb();

  it('fields, entries with approval and files, search and sorting, ratings, import and export', async () => {
    const f = await courseFixture(t.db, 'DATA1');
    const { id } = await f.addActivity('data', 'Библиотека', {
      approvalRequired: true,
      requiredEntriesToView: 1,
      ratingAggregate: 'average',
      ratingMax: 10,
    });
    const [teacher, s1, s2] = await Promise.all(
      [f.users.teacher!, f.users.student1!, f.users.student2!].map((u) => ctxFor(t.db, u)),
    );
    const field = async (type: string, name: string, more: Record<string, unknown> = {}) =>
      ((await runModuleAction(teacher!, id, 'addField', { type, name, ...more })) as { id: string })
        .id;
    const title = await field('text', 'Название', { required: true });
    const year = await field('number', 'Год');
    const genre = await field('menu', 'Жанр', { choices: 'Роман\nПовесть\nПоэма' });
    const tags = await field('checkbox', 'Темы', { choices: 'Космос\nВойна\nЛюбовь' });
    const site = await field('url', 'Сайт');
    const cover = await field('image', 'Обложка');
    await expect(field('text', 'Название')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(field('menu', 'Пусто')).rejects.toThrow(/choices/);
    // learners do not change fields
    await expect(
      runModuleAction(s1!, id, 'addField', { type: 'text', name: 'Моё' }),
    ).rejects.toThrow();

    const add = (ctx: Ctx, values: Record<string, unknown>, files: unknown[] = []) =>
      runModuleAction(ctx, id, 'saveEntry', {
        values,
        files,
        fileFields: files.map(() => cover),
      }) as Promise<{ id: string; approved: boolean }>;
    await expect(add(s1!, { [year]: '1965' })).rejects.toThrow('Название: is required');
    await expect(add(s1!, { [title]: 'Дюна', [genre]: 'Эпос' })).rejects.toThrow(
      'Жанр: is not valid',
    );
    const dune = await add(
      s1!,
      {
        [title]: 'Дюна',
        [year]: '1965',
        [genre]: 'Роман',
        [tags]: ['Война', 'Космос'],
        [site]: 'https://ru.wikipedia.org/wiki/Дюна',
      },
      [{ name: 'dune.png', mimeType: 'image/png', data: PNG }],
    );
    expect(dune.approved).toBe(false);
    // a text file is no picture
    await expect(
      add(s1!, { [title]: 'X' }, [
        { name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a') },
      ]),
    ).rejects.toThrow('Обложка: a picture is needed');

    const list = (ctx: Ctx, q: Record<string, unknown> = {}) =>
      runModuleQuery(ctx, id, 'entries', q) as Promise<Page>;
    // s2 must add an entry before seeing others'; then sees approved ones only
    expect(await list(s2!)).toMatchObject({ total: 0, missing: 1 });
    await add(s2!, { [title]: 'Пикник на обочине', [year]: '1972', [genre]: 'Повесть' });
    expect((await list(s2!)).total).toBe(1);
    await runModuleAction(teacher!, id, 'approveEntry', { id: dune.id, approved: true });
    const seen = await list(s2!, { sort: 'Год', order: 'asc' });
    expect(seen.items.map((e) => e.values[title])).toEqual(['Дюна', 'Пикник на обочине']);
    expect(seen.items[0]!.values[tags]).toBe('Космос\nВойна');
    expect(Object.values(seen.files).map((x) => x.name)).toEqual(['dune.png']);
    expect((await list(s2!, { search: 'КОСМОС' })).items.map((e) => e.values[title])).toEqual([
      'Дюна',
    ]);

    // ratings make the author's grade
    await runModuleAction(teacher!, id, 'rate', { recordId: dune.id, value: 8 });
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: id } });
    const grade = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student1! } },
    });
    expect(Number(grade.finalGrade)).toBe(8);
    // others' entries are not changed by learners
    await expect(
      runModuleAction(s2!, id, 'saveEntry', { id: dune.id, values: { [title]: 'Моё' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // import: columns by field name, bad rows reported by line
    const imported = (await runModuleAction(teacher!, id, 'importCsv', {
      csv: 'Название,Год,Жанр,Лишнее\nСолярис,1961,Роман,x\nОшибка,год,Роман,y\n',
    })) as { created: number; errors: { line: number }[]; skippedColumns: string[] };
    expect(imported).toMatchObject({ created: 1, skippedColumns: ['Лишнее'] });
    expect(imported.errors.map((e) => e.line)).toEqual([3]);

    // export: a column per field, the picture by its file name
    const { recordSheet } = await import('@hubium/mod-data/server');
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    const sheet = await recordSheet(buildModuleCtx(teacher!), toActivityRef(act));
    expect(sheet[0]).toEqual([
      'Название',
      'Год',
      'Жанр',
      'Темы',
      'Сайт',
      'Обложка',
      'user',
      'added',
      'approved',
    ]);
    expect(sheet.find((r) => r[0] === 'Дюна')!.slice(0, 6)).toEqual([
      'Дюна',
      '1965',
      'Роман',
      'Космос, Война',
      'https://ru.wikipedia.org/wiki/Дюна',
      'dune.png',
    ]);

    // deleting a field deletes its values; a backup carries the fields, not the entries
    await runModuleAction(teacher!, id, 'deleteField', { id: site });
    const m = getModule('data')!;
    const data = await m.backup!.export!(buildModuleCtx(teacher!), toActivityRef(act) as never);
    const f2 = await courseFixture(t.db, 'DATA2');
    const { id: copy } = await f2.addActivity('data', 'Копия', {});
    const target = await t.db.activity.findUniqueOrThrow({ where: { id: copy } });
    await m.backup!.import!(
      buildModuleCtx(teacher!),
      toActivityRef(target) as never,
      data,
      () => undefined,
    );
    const copied = await t.db.dataField.findMany({
      where: { activityId: copy },
      orderBy: { sortOrder: 'asc' },
    });
    expect(copied.map((x) => `${x.type}:${x.name}`)).toEqual([
      'text:Название',
      'number:Год',
      'menu:Жанр',
      'checkbox:Темы',
      'image:Обложка',
    ]);
    expect(await t.db.dataRecord.count({ where: { activityId: copy } })).toBe(0);
  });

  it('separate groups show everyone the entries of no group', async () => {
    const f = await courseFixture(t.db, 'DATAGRP');
    const { id } = await f.addActivity('data', 'Справочник', {}, { groupMode: 'SEPARATE' });
    const [teacher, s1, s2] = await Promise.all(
      [f.users.teacher!, f.users.student1!, f.users.student2!].map((u) => ctxFor(t.db, u)),
    );
    await runModuleAction(teacher!, id, 'addField', { type: 'text', name: 'Термин' });
    const [ga, gb] = [
      await t.db.group.create({ data: { courseId: f.courseId, name: 'А' } }),
      await t.db.group.create({ data: { courseId: f.courseId, name: 'Б' } }),
    ];
    await t.db.groupMember.createMany({
      data: [
        { groupId: ga.id, userId: f.users.student1! },
        { groupId: gb.id, userId: f.users.student2! },
      ],
    });
    await runModuleAction(teacher!, id, 'importCsv', { csv: 'Термин\nАтом\nИон\n' });
    await runModuleAction(teacher!, id, 'importCsv', {
      csv: 'Термин\nТолько для А\n',
      groupId: ga.id,
    });
    const total = async (ctx: Ctx) =>
      ((await runModuleQuery(ctx, id, 'entries', {})) as Page).total;
    expect(await total(s1!)).toBe(3);
    expect(await total(s2!)).toBe(2);
  });
});
