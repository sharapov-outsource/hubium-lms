import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { invalidatePermissionCaches } from '../access/permissions.ts';
import { completionReport } from '../completion/completion.ts';
import { enrolUsers } from '../enrol/enrol.ts';
import { graderReport } from './gradebook.ts';

describe('learners in the course reports', () => {
  const t = useTestDb();

  it('are those graded in the course, by any role name, within the viewer groups', async () => {
    const f = await courseFixture(t.db, 'LEARN');
    const admin = await ctxFor(t.db, 'admin@test.local');
    const ids = async (r: { users?: { id: string }[]; learners?: { id: string }[] }) =>
      (r.users ?? r.learners ?? []).map((u) => u.id).sort();
    // a role of the site's own, made from the student's
    const listener = await t.db.role.create({
      data: {
        shortName: 'listener',
        name: { ru: 'Слушатель', en: 'Listener' },
        archetype: 'STUDENT',
        assignableLevels: ['COURSE'],
        capabilities: { create: { capability: 'grade:view', permission: 'ALLOW' } },
      },
    });
    invalidatePermissionCaches('roles');
    await enrolUsers.run(admin, {
      courseId: f.courseId,
      userIds: [f.users.manager!],
      roleId: listener.id,
    });
    const learners = [
      f.users.student1!,
      f.users.student2!,
      f.users.student3!,
      f.users.manager!,
    ].sort();
    const teacher = await ctxFor(t.db, f.users.teacher!);
    expect(await ids(await graderReport(teacher, f.courseId))).toEqual(learners);
    expect(await ids(await completionReport(teacher, f.courseId))).toEqual(learners);
    // a page of them at a time, with how many there are
    const pages = await Promise.all(
      [1, 2].map((page) => graderReport(teacher, f.courseId, { page, pageSize: 3 })),
    );
    expect(pages.map((p) => [p.total, p.users.length])).toEqual([
      [4, 3],
      [4, 1],
    ]);
    expect(pages.flatMap((p) => p.users.map((u) => u.id)).sort()).toEqual(learners);

    // separate groups: a teacher without access to all groups sees their group's
    const group = await t.db.group.create({ data: { courseId: f.courseId, name: 'Группа 1' } });
    await t.db.groupMember.createMany({
      data: [
        { groupId: group.id, userId: f.users.teacher! },
        { groupId: group.id, userId: f.users.student1! },
      ],
    });
    await t.db.course.update({ where: { id: f.courseId }, data: { groupMode: 'SEPARATE' } });
    const assistant = await t.db.role.findUniqueOrThrow({ where: { shortName: 'teacher' } });
    await enrolUsers.run(admin, {
      courseId: f.courseId,
      userIds: [f.users.assistant!],
      roleId: assistant.id,
    });
    await t.db.groupMember.create({ data: { groupId: group.id, userId: f.users.assistant! } });
    // here the role does not see all groups
    await t.db.roleOverride.create({
      data: {
        contextId: f.courseId,
        roleId: assistant.id,
        capability: 'group:accessall',
        permission: 'PROHIBIT',
      },
    });
    invalidatePermissionCaches('roles');
    const nonEditing = await ctxFor(t.db, f.users.assistant!);
    expect(await ids(await graderReport(nonEditing, f.courseId))).toEqual([f.users.student1!]);
    expect(await ids(await graderReport(teacher, f.courseId))).toEqual(learners);
    expect(await ids(await graderReport(teacher, f.courseId, { groupId: group.id }))).toEqual([
      f.users.student1!,
    ]);
  });
});
