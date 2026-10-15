import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { useTestDb } from '../../test/helpers.ts';
import { courseGradePercent } from './course-grade.ts';
import { ensureCourseGradebook } from './gradebook.ts';

describe('course grade as a percentage', () => {
  const t = useTestDb();

  it('counts from the bottom of the range, as reports do', async () => {
    const f = await courseFixture(t.db, 'PCT');
    const { total } = await ensureCourseGradebook(t.db, f.courseId);
    // a total from 2 to 5
    await t.db.gradeItem.update({ where: { id: total.id }, data: { gradeMin: 2, gradeMax: 5 } });
    const percent = async (userId: string, finalGrade: number | null) => {
      await t.db.grade.upsert({
        where: { gradeItemId_userId: { gradeItemId: total.id, userId } },
        create: { gradeItemId: total.id, userId, finalGrade },
        update: { finalGrade },
      });
      return courseGradePercent(t.db, f.courseId, userId);
    };
    expect(await percent(f.users.student1!, 2)).toBe(0);
    expect(await percent(f.users.student1!, 3.5)).toBe(50);
    expect(await percent(f.users.student1!, 5)).toBe(100);
    expect(await percent(f.users.student1!, null)).toBeNull();
    expect(await courseGradePercent(t.db, f.courseId, f.users.student2!)).toBeNull();
  });
});
