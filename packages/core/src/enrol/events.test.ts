import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { resetCourse } from '../courses/reset.ts';
import {
  addCohortSync,
  createCohort,
  removeEnrolmentMethod,
  setCohortMembers,
} from '../groups/groups.ts';

describe('enrolment events', () => {
  const t = useTestDb();

  it('logs enrolling and unenrolling by every method, as the webhooks need', async () => {
    const f = await courseFixture(t.db, 'ENREV');
    const admin = await ctxFor(t.db, 'admin@test.local');
    const events = async () =>
      (
        await t.db.eventLog.findMany({
          where: { courseId: f.courseId, name: { in: ['user.enrolled', 'user.unenrolled'] } },
          orderBy: { id: 'asc' },
        })
      ).map((e) => [e.name, e.relatedUserId, (e.data as { method?: string }).method]);
    const since = async () => (await events()).length;
    const take = async (n: number) => (await events()).slice(n);

    const { id: cohortId } = await createCohort.run(admin, { name: 'Отдел продаж' });
    let n = await since();
    await addCohortSync.run(admin, {
      courseId: f.courseId,
      cohortId,
      roleId: f.roles.student!,
    });
    await setCohortMembers.run(admin, { cohortId, add: [f.users.manager!] });
    expect(await take(n)).toEqual([['user.enrolled', f.users.manager, 'cohort']]);

    n = await since();
    await setCohortMembers.run(admin, { cohortId, remove: [f.users.manager!] });
    expect(await take(n)).toEqual([['user.unenrolled', f.users.manager, 'cohort']]);

    await setCohortMembers.run(admin, { cohortId, add: [f.users.manager!] });
    const method = await t.db.enrolmentMethod.findFirstOrThrow({
      where: { courseId: f.courseId, cohortId },
    });
    n = await since();
    await removeEnrolmentMethod.run(admin, { methodId: method.id });
    expect(await take(n)).toEqual([['user.unenrolled', f.users.manager, 'cohort']]);

    n = await since();
    await resetCourse.run(admin, { courseId: f.courseId, unenrolRoleIds: [f.roles.student!] });
    expect((await take(n)).map(([name, , how]) => `${name} ${how}`)).toEqual([
      'user.unenrolled manual',
      'user.unenrolled manual',
      'user.unenrolled manual',
    ]);
  });
});
