import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import {
  ensureDefaultQuestionCategory,
  importGift,
  listQuestionCategories,
  listQuestions,
  questionsForExport,
  saveQuestion,
  saveQuestionCategory,
} from './bank.ts';

describe('question bank isolation', () => {
  const t = useTestDb();

  it('a teacher cannot touch another course\\u2019s questions or categories', async () => {
    const a = await courseFixture(t.db, 'QB-A');
    const b = await courseFixture(t.db, 'QB-B');
    const sys = await ctxFor(t.db, 'system');
    const catA = await ensureDefaultQuestionCategory(t.db, a.courseId);
    const catB = await ensureDefaultQuestionCategory(t.db, b.courseId);
    const q = {
      type: 'TRUEFALSE' as const,
      name: 'B question',
      text: '<p>B</p>',
      data: { correct: true, feedbackTrue: '', feedbackFalse: '' },
    };
    const { id: qb } = await saveQuestion.run(sys, { ...q, categoryId: catB.id });
    // the teacher of A only (remove from B)
    await t.db.enrolment.deleteMany({ where: { courseId: b.courseId, userId: a.users.teacher } });
    await t.db.roleAssignment.deleteMany({
      where: { contextId: b.courseId, userId: a.users.teacher },
    });
    const teacher = await ctxFor(t.db, a.users.teacher!);

    // overwrite B's question by passing A's category
    await expect(
      saveQuestion.run(teacher, { ...q, id: qb, name: 'hijacked', categoryId: catA.id }),
    ).rejects.toThrow();
    expect((await t.db.question.findUniqueOrThrow({ where: { id: qb } })).name).toBe('B question');

    // rename B's category / nest under it / import into it through course A
    await expect(
      saveQuestionCategory.run(teacher, { courseId: a.courseId, id: catB.id, name: 'x' }),
    ).rejects.toThrow();
    await expect(
      saveQuestionCategory.run(teacher, { courseId: a.courseId, name: 'x', parentId: catB.id }),
    ).rejects.toThrow();
    await expect(
      importGift.run(teacher, {
        courseId: a.courseId,
        categoryId: catB.id,
        gift: '::Q:: 1+1=2 {T}',
      }),
    ).rejects.toThrow();
    expect(await t.db.question.count({ where: { categoryId: catB.id } })).toBe(1);

    // own course still works
    await expect(
      importGift.run(teacher, {
        courseId: a.courseId,
        categoryId: catA.id,
        gift: '::Q:: 1+1=2 {T}',
      }),
    ).resolves.toMatchObject({ created: 1 });
  });

  it('keeps the penalty and the hints that say something', async () => {
    const f = await courseFixture(t.db, 'QB-H');
    const sys = await ctxFor(t.db, 'system');
    const cat = await ensureDefaultQuestionCategory(t.db, f.courseId);
    const { id } = await saveQuestion.run(sys, {
      categoryId: cat.id,
      type: 'TRUEFALSE',
      name: 'Подсказки',
      text: '<p>?</p>',
      data: { correct: true, feedbackTrue: '', feedbackFalse: '' },
      hints: [
        { text: '<p>Подумайте</p><script>x()</script>' },
        { text: '<p>&nbsp;</p>' },
        { text: '', clearWrong: true },
      ],
    });
    const q = await t.db.question.findUniqueOrThrow({ where: { id } });
    // new questions lose a third of the mark per wrong try, as in Moodle
    expect(Number(q.penalty)).toBeCloseTo(1 / 3, 4);
    expect(q.hints).toEqual([
      { text: '<p>Подумайте</p>', clearWrong: false, showNumCorrect: false },
      { text: '', clearWrong: true, showNumCorrect: false },
    ]);
    // an edit without them leaves them as they are
    await saveQuestion.run(sys, {
      id,
      categoryId: cat.id,
      type: 'TRUEFALSE',
      name: 'Подсказки',
      text: '<p>?</p>',
      data: { correct: false, feedbackTrue: '', feedbackFalse: '' },
    });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).hints).toHaveLength(2);
  });

  it('lists a large bank page by page and exports all of it, subcategories too', async () => {
    const f = await courseFixture(t.db, 'QB-P');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const root = await ensureDefaultQuestionCategory(t.db, f.courseId);
    // created before the category they sit under, to check the tree is not by date
    const zeta = await t.db.questionCategory.create({
      data: { contextId: f.courseId, name: 'Zeta', parentId: root.id },
    });
    const { id: alpha } = await saveQuestionCategory.run(teacher, {
      courseId: f.courseId,
      name: 'Alpha',
    });
    const { id: inner } = await saveQuestionCategory.run(teacher, {
      courseId: f.courseId,
      name: 'Inner',
      parentId: zeta.id,
    });
    const make = (categoryId: string, n: number, status = 'READY') =>
      t.db.question.createMany({
        data: Array.from({ length: n }, (_, i) => ({
          categoryId,
          type: 'TRUEFALSE' as const,
          name: `Q${i}`,
          text: `<p>${i}</p>`,
          status: status as 'READY' | 'HIDDEN',
          data: { correct: true, feedbackTrue: '', feedbackFalse: '' },
        })),
      });
    await make(zeta.id, 520);
    await make(zeta.id, 3, 'HIDDEN');
    await make(inner, 7);
    await make(alpha, 2);

    const cats = await listQuestionCategories(teacher, f.courseId);
    expect(cats.map((c) => [c.name, c.depth])).toEqual([
      ['', 0],
      ['Alpha', 1],
      ['Zeta', 1],
      ['Inner', 2],
    ]);
    // the count matches the list, which shows hidden questions too
    expect(cats.find((c) => c.id === zeta.id)!._count.questions).toBe(523);

    const seen = new Set<string>();
    for (let page = 1; page <= 11; page++) {
      const r = await listQuestions(teacher, f.courseId, {
        categoryId: zeta.id,
        includeHidden: true,
        page,
      });
      expect(r.total).toBe(523);
      for (const q of r.items) seen.add(q.id);
    }
    expect(seen.size).toBe(523);

    const all = await questionsForExport(teacher, f.courseId, zeta.id);
    expect(all).toHaveLength(527);
    expect(all.at(-1)!.categoryPath).toEqual(['', 'Zeta', 'Inner']);
    expect((await questionsForExport(teacher, f.courseId)).length).toBe(529);
  });
});
