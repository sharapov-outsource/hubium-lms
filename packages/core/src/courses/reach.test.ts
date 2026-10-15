import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { invalidatePermissionCaches } from '../access/permissions.ts';
import { createCategory } from './categories.ts';
import { coursesWithCap, createCourse } from './courses.ts';

describe('courses in which someone holds a capability', () => {
  const t = useTestDb();

  it('are found among the courses within reach of their roles, past any page of the site', async () => {
    const f = await courseFixture(t.db, 'REACH-T');
    const sys = await ctxFor(t.db, 'system');
    // courses sorting before the teacher's, which they cannot back up
    const { id: categoryId } = await createCategory.run(sys, { name: 'Reach' });
    const other = [];
    for (const n of [1, 2, 3])
      other.push(
        (
          await createCourse.run(sys, {
            categoryId,
            fullName: `AAA ${n}`,
            shortName: `REACH-${n}`,
          })
        ).id,
      );
    const found = async (userId: string, take = 10) =>
      (
        await coursesWithCap(await ctxFor(t.db, userId), 'backup:create', {
          where: { shortName: { startsWith: 'REACH-' } },
          select: { id: true },
          take,
        })
      ).map((c) => c.id);
    const teacher = f.users.teacher!;
    expect(await found(teacher, 1)).toEqual([f.courseId]);
    expect(await found(f.users.student1!)).toEqual([]);

    // a manager of the category reaches its courses
    await t.db.roleAssignment.create({
      data: { userId: teacher, roleId: f.roles.manager!, contextId: categoryId },
    });
    invalidatePermissionCaches();
    expect(await found(teacher)).toEqual([...other, f.courseId]);

    // a prohibition in one course leaves it out
    await t.db.roleOverride.create({
      data: {
        contextId: f.courseId,
        roleId: f.roles.editingteacher!,
        capability: 'backup:create',
        permission: 'PROHIBIT',
      },
    });
    invalidatePermissionCaches();
    expect(await found(teacher)).toEqual(other);

    // a site admin reaches every course
    const admin = await t.db.user.findFirstOrThrow({ where: { isSiteAdmin: true } });
    expect(await found(admin.id)).toEqual([...other, f.courseId]);
  });
});
