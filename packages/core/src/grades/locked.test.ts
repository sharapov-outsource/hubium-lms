import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { writeOds } from '../lib/sheets.ts';
import { createManualItem, overrideGrade, updateGradeItem } from './gradebook.ts';
import { applyGradeImport, previewGradeImport } from './import.ts';

describe('locked grades and pass marks', () => {
  const t = useTestDb();

  it('says a grade is locked instead of leaving it as it was in silence', async () => {
    const f = await courseFixture(t.db, 'GLOCK');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const make = (gradePass?: number) =>
      createManualItem.run(teacher, {
        courseId: f.courseId,
        name: 'Зачёт',
        gradeMax: 10,
        gradePass,
      });
    await expect(make(12)).rejects.toMatchObject({
      fieldErrors: { gradePass: [expect.stringMatching(/above the maximum/)] },
    });
    const { id } = await make(6);
    await expect(updateGradeItem.run(teacher, { id, gradePass: 11 })).rejects.toMatchObject({
      fieldErrors: { gradePass: [expect.stringMatching(/above the maximum/)] },
    });

    const s1 = f.users.student1!;
    await overrideGrade.run(teacher, { itemId: id, userId: s1, value: 5 });
    await t.db.grade.updateMany({ where: { gradeItemId: id, userId: s1 }, data: { locked: true } });
    await expect(
      overrideGrade.run(teacher, { itemId: id, userId: s1, value: 9 }),
    ).rejects.toMatchObject({
      fieldErrors: { value: ['This grade is locked'] },
    });

    const { email } = await t.db.user.findUniqueOrThrow({ where: { id: s1 } });
    const data = writeOds([
      ['Email', 'Зачёт'],
      [email!, '7'],
    ]);
    const { mapping } = await previewGradeImport.run(teacher, { courseId: f.courseId, data });
    const r = await applyGradeImport.run(teacher, { courseId: f.courseId, data, mapping });
    expect(r.updated).toBe(0);
    expect(r.errors).toEqual([{ line: 2, message: 'The grade of “Зачёт” is locked' }]);
    const g = await t.db.grade.findFirstOrThrow({ where: { gradeItemId: id, userId: s1 } });
    expect(Number(g.finalGrade)).toBe(5);
  });
});
