import type { Db } from '@hubium/db';
import { createActivity } from '../src/courses/activities.ts';
import { createCategory } from '../src/courses/categories.ts';
import { createCourse } from '../src/courses/courses.ts';
import { enrolUsers } from '../src/enrol/enrol.ts';
import { ctxFor } from './helpers.ts';

/** A course with teacher + three students (seeded demo users). */
export async function courseFixture(db: Db, shortName: string) {
  const sys = await ctxFor(db, 'system');
  const users = Object.fromEntries(
    (await db.user.findMany({ select: { id: true, username: true } })).map((u) => [
      u.username,
      u.id,
    ]),
  );
  const roles = Object.fromEntries((await db.role.findMany()).map((r) => [r.shortName, r.id]));
  const { id: categoryId } = await createCategory.run(sys, { name: `Cat ${shortName}` });
  const { id: courseId } = await createCourse.run(sys, {
    categoryId,
    fullName: shortName,
    shortName,
    sections: 1,
  });
  await enrolUsers.run(sys, { courseId, userIds: [users.teacher!], roleId: roles.editingteacher! });
  await enrolUsers.run(sys, {
    courseId,
    userIds: [users.student1!, users.student2!, users.student3!],
    roleId: roles.student!,
  });
  const section = await db.courseSection.findFirstOrThrow({
    where: { courseId },
    orderBy: { rank: 'desc' },
  });
  const addActivity = (
    moduleKey: string,
    name: string,
    settings: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    createActivity.run(sys, {
      courseId,
      sectionId: section.id,
      moduleKey,
      name,
      settings,
      ...extra,
    });
  return { courseId, users: users as Record<string, string>, roles, addActivity };
}
