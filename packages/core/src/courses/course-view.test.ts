import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { listBadges } from '../badges/badges.ts';
import { listCertificates } from '../certificates/certificates.ts';
import { courseCompetencies } from '../competencies/ratings.ts';
import type { RequestContext } from '../context.ts';
import { ForbiddenError } from '../errors.ts';

describe('what a course shows to those who may not see it', () => {
  const t = useTestDb();

  it("keeps its badges, certificates and competencies from outsiders, and a hidden course's from its learners", async () => {
    const f = await courseFixture(t.db, 'VIEW1');
    const reads = [
      (c: RequestContext) => listBadges(c, f.courseId),
      (c: RequestContext) => listCertificates(c, f.courseId),
      (c: RequestContext) => courseCompetencies(c, f.courseId),
    ];
    // not enrolled, no guest access
    const outsider = await ctxFor(t.db, f.users.assistant!);
    for (const read of reads) await expect(read(outsider)).rejects.toBeInstanceOf(ForbiddenError);
    const student = await ctxFor(t.db, f.users.student1!);
    for (const read of reads) await expect(read(student)).resolves.toBeTruthy();

    await t.db.course.update({ where: { id: f.courseId }, data: { visible: false } });
    for (const read of reads) await expect(read(student)).rejects.toBeInstanceOf(ForbiddenError);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    for (const read of reads) await expect(read(teacher)).resolves.toBeTruthy();
  });
});
