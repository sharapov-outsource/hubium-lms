import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { writeOds } from '../lib/sheets.ts';
import { writeXlsx } from '../lib/xlsx.ts';
import { createManualItem, ensureCourseGradebook, setGradeCalculation } from './gradebook.ts';
import { applyGradeImport, previewGradeImport } from './import.ts';
import { saveScale } from './scales.ts';

// Importing grades from a sheet: the mapping guessed from the header, a preview that
// shows what would happen, and applying it (manual items take the grade, activities an
// override; feedback too), wrong rows left out.

describe('grade import from sheets', () => {
  const t = useTestDb();

  it('previews, then applies, from ODS and XLSX', async () => {
    const f = await courseFixture(t.db, 'GIMP1');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id: oral } = await createManualItem.run(teacher, {
      courseId: f.courseId,
      name: 'Устный ответ',
      gradeMax: 10,
    } as never);
    const { id: scaleId } = await saveScale.run(teacher, {
      courseId: f.courseId,
      name: 'Зачёт',
      items: ['Не зачтено', 'Зачтено'],
    });
    const { id: pass } = await createManualItem.run(teacher, {
      courseId: f.courseId,
      name: 'Допуск',
      scaleId,
      idNumber: 'admit',
    } as never);
    const { id: calc } = await createManualItem.run(teacher, {
      courseId: f.courseId,
      name: 'Итог',
      gradeMax: 100,
    } as never);
    await setGradeCalculation.run(teacher, { id: calc, calculation: '=[[admit]] * 50' });
    const { id: assignId } = await f.addActivity('assign', 'Эссе', { gradeMax: 20 });
    const essay = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: assignId } });
    const emails = await t.db.user.findMany({
      where: { id: { in: [f.users.student1!, f.users.student2!] } },
      select: { id: true, email: true },
    });
    const email = (id: string) => emails.find((u) => u.id === id)!.email!;
    const rows = [
      ['Email', 'Устный ответ', 'Устный ответ (отзыв)', 'admit', 'Эссе', 'Итог', 'Заметки'],
      [email(f.users.student1!), '8,5', 'Хорошо', 'Зачтено', '15', '100', 'x'],
      [email(f.users.student2!), '11', '', '1', '', '', ''],
      ['nobody@example.com', '5'],
    ];

    // the header gives the mapping: by email, items by name or ID number; the
    // calculated "Итог" and the unknown column are left alone
    const preview = await previewGradeImport.run(teacher, {
      courseId: f.courseId,
      data: writeOds(rows),
    });
    expect(preview.mapping).toEqual({
      userColumn: 0,
      userField: 'email',
      columns: [
        { column: 1, itemId: oral, what: 'grade' },
        { column: 2, itemId: oral, what: 'feedback' },
        { column: 3, itemId: pass, what: 'grade' },
        { column: 4, itemId: essay.id, what: 'grade' },
      ],
    });
    expect(preview.items.map((i) => i.id)).not.toContain(calc);
    // grades counted by item: the oral grade and its feedback are one
    expect(preview.totals).toEqual({ students: 2, grades: 4, errors: 2 });
    expect(preview.problems).toEqual([
      { line: 3, problems: [{ code: 'notAGrade', item: 'Устный ответ', value: '11' }] },
      { line: 4, problems: [{ code: 'noStudent', value: 'nobody@example.com' }] },
    ]);
    // nothing written yet
    expect(await t.db.grade.count({ where: { gradeItemId: oral } })).toBe(0);

    const r = await applyGradeImport.run(teacher, {
      courseId: f.courseId,
      data: writeXlsx(rows),
      mapping: preview.mapping,
    });
    expect(r.updated).toBe(4);
    const g = async (itemId: string, userId: string) =>
      t.db.grade.findUnique({ where: { gradeItemId_userId: { gradeItemId: itemId, userId } } });
    const s1 = f.users.student1!;
    expect(Number((await g(oral, s1))!.finalGrade)).toBe(8.5);
    expect((await g(oral, s1))!.feedback).toBe('Хорошо');
    expect(Number((await g(pass, s1))!.finalGrade)).toBe(2);
    // the activity's grade is overridden, as from the grader report
    expect(await g(essay.id, s1)).toMatchObject({ overridden: true });
    expect(Number((await g(essay.id, s1))!.finalGrade)).toBe(15);
    // the formula follows the imported grades
    expect(Number((await g(calc, s1))!.finalGrade)).toBe(100);
    // the wrong cell is left out, the rest of its row comes in
    expect(await g(oral, f.users.student2!)).toBeNull();
    expect(Number((await g(pass, f.users.student2!))!.finalGrade)).toBe(1);
    const history = await t.db.gradeHistory.findFirstOrThrow({
      where: { grade: { gradeItemId: oral, userId: s1 } },
    });
    expect(history.source).toBe('import');
  });

  it('refuses a mapping onto what cannot be imported', async () => {
    const f = await courseFixture(t.db, 'GIMP2');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { total } = await ensureCourseGradebook(t.db, f.courseId);
    await expect(
      previewGradeImport.run(teacher, {
        courseId: f.courseId,
        data: writeOds([['email', 'Итог курса']]),
        mapping: {
          userColumn: 0,
          userField: 'email',
          columns: [{ column: 1, itemId: total.id, what: 'grade' }],
        },
      }),
    ).rejects.toThrow();
    const student = await ctxFor(t.db, f.users.student1!);
    await expect(
      previewGradeImport.run(student, { courseId: f.courseId, data: writeOds([['email']]) }),
    ).rejects.toThrow();
  });
});
