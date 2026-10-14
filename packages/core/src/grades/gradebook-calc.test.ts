import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { deleteActivity, restoreActivity, updateActivity } from '../courses/activities.ts';
import { ValidationError } from '../errors.ts';
import {
  createManualItem,
  deleteGradeCategory,
  deleteManualItem,
  displayCalculations,
  overrideGrade,
  saveGradeCategory,
  setGradeCalculation,
  updateGradeItem,
} from './gradebook.ts';

// Calculated grade items: formulas over items and categories by ID number, recomputed with
// every grade, overridable, and kept consistent when what they use changes or goes.

describe('gradebook calculations', () => {
  const t = useTestDb();

  async function setup(code: string) {
    const f = await courseFixture(t.db, code);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id: catId } = await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      name: 'Домашние',
      aggregation: 'NATURAL',
      idNumber: 'homework',
    });
    const item = (name: string, idNumber: string, extra: Record<string, unknown> = {}) =>
      createManualItem.run(teacher, {
        courseId: f.courseId,
        name,
        idNumber,
        gradeMax: 10,
        ...extra,
      } as never);
    const hw1 = await item('ДЗ 1', 'hw1', { categoryId: catId });
    const hw2 = await item('ДЗ 2', 'hw2', { categoryId: catId });
    const final = await item('Итог', 'final', { gradeMax: 100 });
    const grade = (itemId: string, userId: string, value: number | null) =>
      overrideGrade.run(teacher, { itemId, userId, value });
    const value = async (itemId: string, userId: string) => {
      const g = await t.db.grade.findUnique({
        where: { gradeItemId_userId: { gradeItemId: itemId, userId } },
      });
      return g?.finalGrade === null || g?.finalGrade === undefined ? null : Number(g.finalGrade);
    };
    return { f, teacher, catId, hw1, hw2, final, grade, value };
  }
  const fails = async (p: Promise<unknown>, re: RegExp) => {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((e as ValidationError).fieldErrors)).toMatch(re);
  };

  it('computes from other items; empty counts as 0 unless all are empty', async () => {
    const { f, teacher, hw1, hw2, final, grade, value } = await setup('GCALC1');
    const [s1, s2, s3] = [f.users.student1!, f.users.student2!, f.users.student3!];
    await setGradeCalculation.run(teacher, {
      id: final.id,
      calculation: '=([[HW1]] + [[hw2]]) * 5',
    });
    await grade(hw1.id, s1, 8);
    await grade(hw2.id, s1, 6);
    await grade(hw1.id, s2, 4);
    expect(await value(final.id, s1)).toBe(70);
    expect(await value(final.id, s2)).toBe(20);
    expect(await value(final.id, s3)).toBeNull();
    // a teacher overrides the calculated grade; clearing it brings back the formula's
    await grade(final.id, s1, 99);
    await grade(hw1.id, s1, 10);
    expect(await value(final.id, s1)).toBe(99);
    await grade(final.id, s1, null);
    expect(await value(final.id, s1)).toBe(80);
    // the formula reads back with ID numbers, which may change
    await updateGradeItem.run(teacher, { id: hw2.id, idNumber: 'task2' });
    const [items, categories] = await Promise.all([
      t.db.gradeItem.findMany({ where: { courseId: f.courseId } }),
      t.db.gradeCategory.findMany({ where: { courseId: f.courseId } }),
    ]);
    expect(displayCalculations(items, categories).get(final.id)).toBe('=([[hw1]] + [[task2]]) * 5');
    // what a formula uses cannot lose its ID number or go
    await fails(updateGradeItem.run(teacher, { id: hw1.id, idNumber: null }), /Formulas use/);
    await fails(deleteManualItem.run(teacher, { id: hw1.id }), /Formulas use this item/);
  });

  it('uses categories, and refuses formulas that use their own grade', async () => {
    const { f, teacher, catId, hw1, hw2, final, grade, value } = await setup('GCALC2');
    const s1 = f.users.student1!;
    await grade(hw1.id, s1, 8);
    await grade(hw2.id, s1, 6);
    // the category's points: 14 of 20
    await setGradeCalculation.run(teacher, { id: final.id, calculation: '=[[homework]] * 5' });
    expect(await value(final.id, s1)).toBe(70);
    await fails(
      setGradeCalculation.run(teacher, { id: final.id, calculation: '=[[final]] + 1' }),
      /own grade/,
    );
    await fails(
      setGradeCalculation.run(teacher, { id: hw1.id, calculation: '=[[homework]]' }),
      /own grade/,
    );
    await fails(
      setGradeCalculation.run(teacher, { id: hw1.id, calculation: '=[[nothing]] * 2' }),
      /nothing/,
    );
    await fails(
      setGradeCalculation.run(teacher, { id: hw1.id, calculation: '=[[hw2]] +' }),
      /ends too early \(at 11\)/,
    );
    // nor move the calculated item into the category its formula uses
    await fails(updateGradeItem.run(teacher, { id: final.id, categoryId: catId }), /own grade/);
    await fails(deleteGradeCategory.run(teacher, { courseId: f.courseId, id: catId }), /Formulas/);
    // ID numbers are one per course, items and categories alike
    await fails(
      createManualItem.run(teacher, {
        courseId: f.courseId,
        name: 'Ещё',
        idNumber: 'HOMEWORK',
      } as never),
      /already used/,
    );
  });

  it('follows activities: their ID number, and their grades leaving with them', async () => {
    const { f, teacher, final, value } = await setup('GCALC3');
    const s1 = f.users.student1!;
    const { id: assignId } = await f.addActivity(
      'assign',
      'Эссе',
      { gradeMax: 20 },
      { idNumber: 'essay' },
    );
    const essay = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: assignId } });
    expect(essay.idNumber).toBe('essay');
    await setGradeCalculation.run(teacher, { id: final.id, calculation: '=[[essay]] * 5' });
    await overrideGrade.run(teacher, { itemId: essay.id, userId: s1, value: 15 });
    expect(await value(final.id, s1)).toBe(75);
    // an activity cannot take an ID number the gradebook has, nor drop one formulas use
    await expect(f.addActivity('assign', 'Другое', {}, { idNumber: 'hw1' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const act = await t.db.activity.findUniqueOrThrow({ where: { id: assignId } });
    await expect(
      updateActivity.run(teacher, {
        id: assignId,
        name: act.name,
        settings: act.settings as object,
        idNumber: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // the activity in the recycle bin: no grade, and the formula is flagged
    await deleteActivity.run(teacher, { id: assignId });
    expect(await value(final.id, s1)).toBeNull();
    expect((await t.db.gradeItem.findUniqueOrThrow({ where: { id: final.id } })).needsUpdate).toBe(
      true,
    );
    await restoreActivity.run(teacher, { id: assignId });
    expect(await value(final.id, s1)).toBe(75);
    expect((await t.db.gradeItem.findUniqueOrThrow({ where: { id: final.id } })).needsUpdate).toBe(
      false,
    );
    // only manual items graded in points calculate
    await fails(
      setGradeCalculation.run(teacher, { id: essay.id, calculation: '=1' }),
      /Only manual items/,
    );
  });
});
