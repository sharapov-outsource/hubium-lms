import { uuidv7 } from '@hubium/db';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import {
  ensureCourseGradebook,
  GRADES_RECALC_JOB,
  recalcCourseTotals,
  saveGradeCategory,
} from './gradebook.ts';

describe('course totals of a large course', () => {
  const t = useTestDb();

  it('are worked out by the worker in batches after a change for everyone', async () => {
    const f = await courseFixture(t.db, 'RECALC');
    const method = await t.db.enrolmentMethod.findFirstOrThrow({
      where: { courseId: f.courseId, type: 'MANUAL' },
    });
    // 250 more people in the course than are worked out at once
    const ids = Array.from({ length: 250 }, () => uuidv7());
    await t.db.user.createMany({
      data: ids.map((id, i) => ({
        id,
        email: `recalc-${i}@example.org`,
        name: `R ${i}`,
        firstName: 'R',
        lastName: `${i}`,
      })),
    });
    await t.db.enrolment.createMany({
      data: ids.map((userId) => ({ courseId: f.courseId, methodId: method.id, userId })),
    });
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { root } = await ensureCourseGradebook(t.db, f.courseId);
    const jobs = capturedJobs.length;
    await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      id: root.id,
      aggregation: 'MEAN',
    });
    // the change is saved at once; the totals go to the worker
    expect(capturedJobs.slice(jobs).filter((j) => j.name === GRADES_RECALC_JOB)).toHaveLength(1);
    expect(await recalcCourseTotals(t.db, f.courseId)).toBe(254);
  });
});
