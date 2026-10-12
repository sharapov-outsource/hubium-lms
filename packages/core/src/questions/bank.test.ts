import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import {
  ensureDefaultQuestionCategory,
  importGift,
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
});
