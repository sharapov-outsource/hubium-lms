import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { runModuleAction } from '../modules/actions.ts';
import {
  createManualItem,
  exportGradesCsv,
  graderReport,
  overrideGrade,
  saveGradeCategory,
  updateGradeItem,
  userReport,
} from './gradebook.ts';
import { applyGradeImport, previewGradeImport } from './import.ts';

const total = async (db: import('@hubium/db').Db, courseId: string, userId: string) => {
  const item = await db.gradeItem.findFirstOrThrow({ where: { courseId, kind: 'COURSE' } });
  const g = await db.grade.findUnique({
    where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
  });
  return g?.finalGrade === null || g?.finalGrade === undefined ? null : Number(g.finalGrade);
};

/** A CSV imported as the import page does: the mapping it suggests, then applied. */
async function importCsv(ctx: Awaited<ReturnType<typeof ctxFor>>, courseId: string, csv: string) {
  const data = new TextEncoder().encode(csv);
  const { mapping } = await previewGradeImport.run(ctx, { courseId, data });
  return applyGradeImport.run(ctx, { courseId, data, mapping });
}

describe('gradebook', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let assignId: string;
  let manualId: string;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'GRADES1');
    assignId = (await f.addActivity('assign', 'Контрольная', { gradeMax: 50 })).id;
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    manualId = (
      await createManualItem.run(teacher, {
        courseId: f.courseId,
        name: 'Устный ответ',
        gradeMax: 10,
      })
    ).id;
  });

  it('natural total sums points across items', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    await runModuleAction(teacher, assignId, 'grade', { userId: f.users.student1, grade: 40 });
    await overrideGrade.run(teacher, { itemId: manualId, userId: f.users.student1!, value: 5 });
    // (40 + 5) / (50 + 10) = 75%
    expect(await total(t.db, f.courseId, f.users.student1!)).toBeCloseTo(75);
  });

  it('activities in the recycle bin stop counting towards the total', async () => {
    const g = await courseFixture(t.db, 'GRADES3');
    const admin = await ctxFor(t.db, 'admin@test.local');
    const a1 = (await g.addActivity('assign', 'Первое', { gradeMax: 10 })).id;
    const a2 = (await g.addActivity('assign', 'Второе', { gradeMax: 10 })).id;
    await runModuleAction(admin, a1, 'grade', { userId: g.users.student1, grade: 10 });
    await runModuleAction(admin, a2, 'grade', { userId: g.users.student1, grade: 0 });
    expect(await total(t.db, g.courseId, g.users.student1!)).toBeCloseTo(50);
    const { deleteActivity, restoreActivity } = await import('../courses/activities.ts');
    await deleteActivity.run(admin, { id: a2 });
    expect(await total(t.db, g.courseId, g.users.student1!)).toBeCloseTo(100);
    await restoreActivity.run(admin, { id: a2 });
    expect(await total(t.db, g.courseId, g.users.student1!)).toBeCloseTo(50);
  });

  it('grade categories of another course cannot be used or edited', async () => {
    const other = await courseFixture(t.db, 'GRADES2');
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id: foreign } = await saveGradeCategory.run(admin, {
      courseId: other.courseId,
      name: 'Чужая',
      aggregation: 'MEAN',
    });
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    await expect(
      saveGradeCategory.run(teacher, {
        courseId: f.courseId,
        id: foreign,
        name: 'Моя',
        aggregation: 'HIGHEST',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createManualItem.run(teacher, { courseId: f.courseId, name: 'X', categoryId: foreign }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateGradeItem.run(teacher, { id: manualId, categoryId: foreign }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await t.db.gradeCategory.findUniqueOrThrow({ where: { id: foreign } })).name).toBe(
      'Чужая',
    );
  });

  it('validates range and enrolment; students cannot edit', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    await expect(
      overrideGrade.run(teacher, { itemId: manualId, userId: f.users.student1!, value: 11 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      overrideGrade.run(teacher, { itemId: manualId, userId: f.users.manager!, value: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    const s = await ctxFor(t.db, 'student1@hubium.local');
    await expect(
      overrideGrade.run(s, { itemId: manualId, userId: f.users.student1!, value: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('overriding a module grade freezes it; clearing restores the module value', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: assignId } });
    await overrideGrade.run(teacher, { itemId: item.id, userId: f.users.student1!, value: 50 });
    await runModuleAction(teacher, assignId, 'grade', { userId: f.users.student1, grade: 10 });
    let g = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student1! } },
    });
    expect(Number(g.finalGrade)).toBe(50);
    expect(Number(g.rawGrade)).toBe(10);
    await overrideGrade.run(teacher, { itemId: item.id, userId: f.users.student1!, value: null });
    g = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student1! } },
    });
    expect(Number(g.finalGrade)).toBe(10);
    expect(g.overridden).toBe(false);
    expect(await t.db.gradeHistory.count({ where: { gradeId: g.id } })).toBeGreaterThanOrEqual(3);
  });

  it('switching the course aggregation to weighted mean changes the total', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const root = await t.db.gradeCategory.findFirstOrThrow({
      where: { courseId: f.courseId, parentId: null },
    });
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: assignId } });
    await updateGradeItem.run(teacher, { id: item.id, weight: 3 });
    await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      id: root.id,
      aggregation: 'WEIGHTED_MEAN',
    });
    // assign 10/50 = 0.2 (w3), manual 5/10 = 0.5 (w1) → (0.6 + 0.5) / 4 = 27.5%
    expect(await total(t.db, f.courseId, f.users.student1!)).toBeCloseTo(27.5);
  });

  it('grader report and user report; hidden items are hidden from the learner', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const r = await graderReport(teacher, f.courseId);
    expect(r.users.map((u) => u.id)).toContain(f.users.student1);
    expect(r.users.map((u) => u.id)).not.toContain(f.users.teacher);
    await updateGradeItem.run(teacher, { id: manualId, hidden: true });
    const s1 = await ctxFor(t.db, 'student1@hubium.local');
    const mine = await userReport(s1, f.courseId, f.users.student1!);
    expect(mine.items.some((i) => i.id === manualId)).toBe(false);
    await expect(userReport(s1, f.courseId, f.users.student2!)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('a hidden item stays hidden through activity edits, and the learner total leaves it out', async () => {
    const g = await courseFixture(t.db, 'GRADES5');
    const teacher = await ctxFor(t.db, g.users.teacher!);
    const quiz = (await g.addActivity('assign', 'Тест', { gradeMax: 10 })).id;
    const exam = (await g.addActivity('assign', 'Экзамен', { gradeMax: 100 })).id;
    await runModuleAction(teacher, quiz, 'grade', { userId: g.users.student1, grade: 10 });
    await runModuleAction(teacher, exam, 'grade', { userId: g.users.student1, grade: 80 });
    const stored = (90 / 110) * 100;
    expect(await total(t.db, g.courseId, g.users.student1!)).toBeCloseTo(stored);
    const examItem = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: exam } });
    await updateGradeItem.run(teacher, { id: examItem.id, hidden: true });
    // editing the activity keeps the teacher's choice
    await updateActivity.run(teacher, {
      id: exam,
      name: 'Экзамен (итог)',
      settings: { gradeMax: 100 },
    });
    expect((await t.db.gradeItem.findUniqueOrThrow({ where: { id: examItem.id } })).hidden).toBe(
      true,
    );
    // the learner's total is over what they see (10 of 10), not a figure that gives the exam away
    const s1 = await ctxFor(t.db, g.users.student1!);
    const mine = await userReport(s1, g.courseId, g.users.student1!);
    const totalId = mine.items.find((i) => i.kind === 'COURSE')!.id;
    expect(Number(mine.grades.get(totalId)?.finalGrade)).toBeCloseTo(100);
    const theirs = await userReport(teacher, g.courseId, g.users.student1!);
    expect(Number(theirs.grades.get(totalId)?.finalGrade)).toBeCloseTo(stored);
  });

  it('CSV import fills manual items and reports bad rows; export includes totals', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const csv = 'username;Устный ответ\nstudent2;8\nstudent3;99\nnobody;1\n';
    const r = await importCsv(teacher, f.courseId, csv);
    expect(r.updated).toBe(1);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);
    const out = await exportGradesCsv(teacher, f.courseId);
    expect(out).toContain('Course total');
    expect(out).toContain('Устный ответ');
    expect(out.split('\r\n').find((l) => l.includes('student2'))).toContain('8');
  });
});
