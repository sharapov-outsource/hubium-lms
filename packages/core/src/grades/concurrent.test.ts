import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import {
  createManualItem,
  ensureCourseGradebook,
  recomputeCourseTotals,
  writeGrade,
} from './gradebook.ts';

describe('grades written at the same time', () => {
  const t = useTestDb();

  it('both count in the course total', async () => {
    const f = await courseFixture(t.db, 'GRRACE');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const item = async (name: string) =>
      t.db.gradeItem.findUniqueOrThrow({
        where: {
          id: (await createManualItem.run(teacher, { courseId: f.courseId, name, gradeMax: 10 }))
            .id,
        },
      });
    const [a, b] = [await item('Тест 1'), await item('Тест 2')];
    const { total } = await ensureCourseGradebook(t.db, f.courseId);
    const s = f.users.student1!;
    const grade = (tx: Parameters<typeof writeGrade>[0], it: typeof a, v: number) =>
      writeGrade(tx, it, s, { rawGrade: v }, { source: 'test' });

    // the first has worked out the total and not yet committed when the second does
    let ready!: () => void;
    const first = new Promise<void>((r) => {
      ready = r;
    });
    await Promise.all([
      t.db.$transaction(
        async (tx) => {
          await grade(tx, a, 10);
          await recomputeCourseTotals(tx, f.courseId, [s]);
          ready();
          await new Promise((r) => setTimeout(r, 300));
        },
        { timeout: 10_000 },
      ),
      first.then(() =>
        t.db.$transaction(
          async (tx) => {
            await grade(tx, b, 10);
            await recomputeCourseTotals(tx, f.courseId, [s]);
          },
          { timeout: 10_000 },
        ),
      ),
    ]);
    const row = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: total.id, userId: s } },
    });
    expect(Number(row.finalGrade)).toBe(100);
  });
});
