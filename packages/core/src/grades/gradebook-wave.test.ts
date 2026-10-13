import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ConflictError, ValidationError } from '../errors.ts';
import { runModuleAction } from '../modules/actions.ts';
import { setSettings } from '../settings/settings.ts';
import {
  createManualItem,
  deleteGradeCategory,
  ensureCourseGradebook,
  exportGradesXlsx,
  gradeExportRows,
  gradeHistory,
  importGradesCsv,
  moveGradebookEntry,
  overrideGrade,
  saveGradeCategory,
  updateGradeItem,
} from './gradebook.ts';
import { courseLetters, deleteScale, saveLetters, saveScale } from './scales.ts';

const total = async (db: import('@hubium/db').Db, courseId: string, userId: string) => {
  const item = await db.gradeItem.findFirstOrThrow({ where: { courseId, kind: 'COURSE' } });
  const g = await db.grade.findUnique({
    where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
  });
  return g?.finalGrade === null || g?.finalGrade === undefined ? null : Number(g.finalGrade);
};

describe('gradebook: categories, scales, letters, history, export', () => {
  const t = useTestDb();

  async function course(code: string) {
    const f = await courseFixture(t.db, code);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const item = async (name: string, gradeMax: number, categoryId?: string) =>
      (await createManualItem.run(teacher, { courseId: f.courseId, name, gradeMax, categoryId }))
        .id;
    const { root } = await ensureCourseGradebook(t.db, f.courseId);
    return { f, teacher, item, root };
  }

  it('counts a natural subcategory by its points, not as 100', async () => {
    const { f, teacher, item, root } = await course('GBW1');
    const { id: cat } = await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      name: 'Лабораторные',
      aggregation: 'NATURAL',
    });
    const a1 = await item('Лаба 1', 10, cat);
    const a2 = await item('Лаба 2', 10, cat);
    const r1 = await item('Экзамен', 20);
    const s = f.users.student1!;
    for (const [itemId, value] of [
      [a1, 10],
      [a2, 0],
      [r1, 20],
    ] as const)
      await overrideGrade.run(teacher, { itemId, userId: s, value });
    // (10 + 0 + 20) / (10 + 10 + 20)
    expect(await total(t.db, f.courseId, s)).toBeCloseTo(75);

    // a weighted mean at the top uses the category's weight
    await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      id: root.id,
      aggregation: 'WEIGHTED_MEAN',
    });
    await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      id: cat,
      name: 'Лабораторные',
      aggregation: 'MEAN',
      weight: 3,
    });
    // category 50% × 3 and exam 100% × 1
    expect(await total(t.db, f.courseId, s)).toBeCloseTo(62.5);
  });

  it('nests, reorders and deletes categories without losing items', async () => {
    const { f, teacher, item } = await course('GBW2');
    const { id: outer } = await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      name: 'Внешняя',
      aggregation: 'NATURAL',
    });
    const { id: inner } = await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      parentId: outer,
      name: 'Внутренняя',
      aggregation: 'NATURAL',
    });
    const it1 = await item('Работа', 10, inner);
    await expect(
      saveGradeCategory.run(teacher, {
        courseId: f.courseId,
        id: outer,
        parentId: inner,
        name: 'Внешняя',
        aggregation: 'NATURAL',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const { id: second } = await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      name: 'Вторая',
      aggregation: 'NATURAL',
    });
    await moveGradebookEntry.run(teacher, {
      courseId: f.courseId,
      kind: 'category',
      id: second,
      direction: 'up',
    });
    const order = await t.db.gradeCategory.findMany({
      where: { courseId: f.courseId, parentId: { not: null }, name: { in: ['Внешняя', 'Вторая'] } },
      orderBy: { sortOrder: 'asc' },
    });
    expect(order.map((c) => c.name)).toEqual(['Вторая', 'Внешняя']);

    await deleteGradeCategory.run(teacher, { courseId: f.courseId, id: inner });
    expect((await t.db.gradeItem.findUniqueOrThrow({ where: { id: it1 } })).categoryId).toBe(outer);
    await updateGradeItem.run(teacher, { id: it1, categoryId: second });
    expect((await t.db.gradeItem.findUniqueOrThrow({ where: { id: it1 } })).categoryId).toBe(
      second,
    );
  });

  it('grades on a scale, exported and imported by name', async () => {
    const { f, teacher } = await course('GBW3');
    const { id: scaleId } = await saveScale.run(teacher, {
      courseId: f.courseId,
      name: 'Зачёт',
      items: ['Плохо', 'Хорошо', 'Отлично'],
    });
    const { id: itemId } = await createManualItem.run(teacher, {
      courseId: f.courseId,
      name: 'Проект',
      scaleId,
    });
    const item = await t.db.gradeItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item).toMatchObject({ gradeType: 'SCALE' });
    expect([Number(item.gradeMin), Number(item.gradeMax)]).toEqual([1, 3]);
    const s = f.users.student1!;
    await expect(
      overrideGrade.run(teacher, { itemId, userId: s, value: 2.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await overrideGrade.run(teacher, { itemId, userId: s, value: 3 });
    const rows = await gradeExportRows(teacher, f.courseId);
    const col = rows[0]!.indexOf('Проект');
    expect(rows.find((r) => r[0] === 'Иван Петров')?.[col]).toBe('Отлично');

    await importGradesCsv.run(teacher, {
      courseId: f.courseId,
      csv: 'username,Проект\nstudent1,Хорошо\n',
    });
    const g = await t.db.grade.findFirstOrThrow({ where: { gradeItemId: itemId, userId: s } });
    expect(Number(g.finalGrade)).toBe(2);

    // a scale in use keeps its length and cannot be deleted
    await expect(
      saveScale.run(teacher, { id: scaleId, name: 'Зачёт', items: ['Нет', 'Да'] }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteScale.run(teacher, { id: scaleId })).rejects.toBeInstanceOf(ConflictError);
    // a site scale needs site configuration rights
    await expect(
      saveScale.run(teacher, { courseId: null, name: 'Сайт', items: ['a', 'b'] }),
    ).rejects.toThrow();
  });

  it('grades an assignment on a scale', async () => {
    const { f, teacher } = await course('GBW4');
    const { id: scaleId } = await saveScale.run(teacher, {
      courseId: f.courseId,
      name: 'Уровни',
      items: ['Начальный', 'Средний', 'Высокий', 'Продвинутый'],
    });
    const { id } = await f.addActivity('assign', 'Эссе', { gradeMax: 100, scaleId });
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: id } });
    expect([item.gradeType, Number(item.gradeMax)]).toEqual(['SCALE', 4]);
    await expect(
      runModuleAction(teacher, id, 'grade', { userId: f.users.student1, grade: 7 }),
    ).rejects.toThrow('Choose a grade of the scale');
    await runModuleAction(teacher, id, 'grade', { userId: f.users.student1, grade: 3 });
    const g = await t.db.grade.findFirstOrThrow({
      where: { gradeItemId: item.id, userId: f.users.student1! },
    });
    expect(Number(g.finalGrade)).toBe(3);
  });

  it('takes letters from the course, then the site, then the site language', async () => {
    const { f, teacher } = await course('GBW5');
    const admin = await ctxFor(t.db, 'admin@test.local');
    await setSettings(t.db, { 'site.defaultLocale': 'en' });
    try {
      expect((await courseLetters(t.db, f.courseId))[0]).toEqual({ lowerBound: 90, letter: 'A' });
      await saveLetters.run(admin, {
        contextId: SYSTEM_CONTEXT_ID,
        letters: [
          { lowerBound: 50, letter: 'зачёт' },
          { lowerBound: 0, letter: 'незачёт' },
        ],
      });
      expect((await courseLetters(t.db, f.courseId)).map((l) => l.letter)).toEqual([
        'зачёт',
        'незачёт',
      ]);
      await saveLetters.run(teacher, {
        contextId: f.courseId,
        letters: [
          { lowerBound: 60, letter: 'P' },
          { lowerBound: 0, letter: 'F' },
        ],
      });
      expect((await courseLetters(t.db, f.courseId))[0]?.letter).toBe('P');
      await expect(
        saveLetters.run(teacher, {
          contextId: f.courseId,
          letters: [{ lowerBound: 50, letter: 'X' }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await saveLetters.run(teacher, { contextId: f.courseId, letters: [] });
      expect((await courseLetters(t.db, f.courseId))[0]?.letter).toBe('зачёт');
    } finally {
      await saveLetters.run(admin, { contextId: SYSTEM_CONTEXT_ID, letters: [] });
      await setSettings(t.db, { 'site.defaultLocale': 'ru' });
    }
  });

  it('keeps a history of real changes, including clearing an override', async () => {
    const { f, teacher } = await course('GBW6');
    const { id: assignId } = await f.addActivity('assign', 'Тест', { gradeMax: 10 });
    const s = f.users.student1!;
    await runModuleAction(teacher, assignId, 'grade', { userId: s, grade: 6 });
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: assignId } });
    await overrideGrade.run(teacher, { itemId: item.id, userId: s, value: 9 });
    await overrideGrade.run(teacher, { itemId: item.id, userId: s, value: null });
    const g = await t.db.grade.findFirstOrThrow({ where: { gradeItemId: item.id, userId: s } });
    expect([Number(g.finalGrade), g.overridden]).toEqual([6, false]);

    const h = await gradeHistory(teacher, f.courseId, { userId: s, itemId: item.id });
    expect(h.rows.map((r) => [r.previousGrade, r.finalGrade, r.source, r.overridden])).toEqual([
      [9, 6, 'override', false],
      [6, 9, 'override', true],
      [null, 6, 'module', false],
    ]);
    expect(h.rows[0]?.changedBy?.name).toBe('Анна Преподавателева');

    // saving the same grade again records nothing new
    await runModuleAction(teacher, assignId, 'grade', { userId: s, grade: 6 });
    expect((await gradeHistory(teacher, f.courseId, { userId: s, itemId: item.id })).total).toBe(3);
  });

  it('exports grades as an .xlsx workbook', async () => {
    const { f, teacher, item } = await course('GBW7');
    const id = await item('Опрос', 5);
    await overrideGrade.run(teacher, { itemId: id, userId: f.users.student1!, value: 4 });
    const files = unzipSync(await exportGradesXlsx(teacher, f.courseId));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ]),
    );
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<t xml:space="preserve">Опрос</t>');
    expect(sheet).toMatch(/<c r="D2"><v>4<\/v><\/c>|<c r="D\d"><v>4<\/v><\/c>/);
  });
});
