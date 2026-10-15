import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { getCourseAccess } from '../courses/courses.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import {
  addCohortSync,
  createCohort,
  createGroup,
  deleteCohort,
  setCohortMembers,
  setGroupMembers,
} from '../groups/groups.ts';
import { openGroupChat } from '../messaging/messaging.ts';
import { assignSystemRole } from '../users/users.ts';
import {
  enrolUsers,
  selfEnrol,
  setCourseRoles,
  setEnrolmentStatus,
  unenrolSelf,
  updateSelfEnrolment,
} from './enrol.ts';

describe('enrolment rules', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'ENROL1');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await updateSelfEnrolment.run(teacher, { courseId: f.courseId, enabled: true });
  });

  const canView = async (userId: string) =>
    (await getCourseAccess(await ctxFor(t.db, userId), f.courseId)).canView;

  it('a suspended learner cannot re-activate themselves through self enrolment', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await setEnrolmentStatus.run(teacher, {
      courseId: f.courseId,
      userId: f.users.student1!,
      status: 'SUSPENDED',
    });
    const s1 = await ctxFor(t.db, f.users.student1!);
    await expect(selfEnrol.run(s1, { courseId: f.courseId })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await canView(f.users.student1!)).toBe(false);
  });

  it('an expired enrolment can be renewed by self enrolment', async () => {
    await t.db.enrolment.updateMany({
      where: { courseId: f.courseId, userId: f.users.student2! },
      data: { status: 'SUSPENDED', endsAt: new Date(Date.now() - 1000) },
    });
    expect(await canView(f.users.student2!)).toBe(false);
    await t.db.enrolmentMethod.updateMany({
      where: { courseId: f.courseId, type: 'SELF' },
      data: { welcome: 'Добро пожаловать! Начните с вводного раздела.' },
    });
    await selfEnrol.run(await ctxFor(t.db, f.users.student2!), { courseId: f.courseId });
    expect(await canView(f.users.student2!)).toBe(true);
    // the course's welcome reaches them
    expect(
      await t.db.notification.findFirst({
        where: { userId: f.users.student2!, type: 'enrol.enrolled', courseId: f.courseId },
        select: { body: true },
      }),
    ).toEqual({ body: 'Добро пожаловать! Начните с вводного раздела.' });
    // a second self enrolment is a conflict while the first one is current
    await expect(
      selfEnrol.run(await ctxFor(t.db, f.users.student2!), { courseId: f.courseId }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('the same role can come from several enrolments', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id: cohortId } = await createCohort.run(admin, { name: 'Поток А' });
    await setCohortMembers.run(admin, { cohortId, add: [f.users.student3!] });
    // student3 is already enrolled manually as a student
    await addCohortSync.run(admin, { courseId: f.courseId, cohortId, roleId: f.roles.student! });
    await expect(
      addCohortSync.run(admin, { courseId: f.courseId, cohortId, roleId: f.roles.student! }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await t.db.roleAssignment.count({
        where: { userId: f.users.student3!, contextId: f.courseId, roleId: f.roles.student! },
      }),
    ).toBe(2);
    // suspending the manual enrolment leaves access through the cohort
    const manual = await t.db.enrolment.findFirstOrThrow({
      where: { courseId: f.courseId, userId: f.users.student3!, method: { type: 'MANUAL' } },
    });
    await t.db.enrolment.update({ where: { id: manual.id }, data: { status: 'SUSPENDED' } });
    expect(await canView(f.users.student3!)).toBe(true);
    await t.db.enrolment.update({ where: { id: manual.id }, data: { status: 'ACTIVE' } });

    // deleting the cohort removes its enrolments but not the manual one
    await deleteCohort.run(admin, { id: cohortId });
    expect(
      await t.db.enrolment.count({ where: { courseId: f.courseId, userId: f.users.student3! } }),
    ).toBe(1);
    expect(await canView(f.users.student3!)).toBe(true);
  });

  it('teachers cannot sync cohorts or set roles beyond what they may assign', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id: cohortId } = await createCohort.run(admin, { name: 'Поток Б' });
    await expect(
      addCohortSync.run(teacher, { courseId: f.courseId, cohortId, roleId: f.roles.manager! }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      addCohortSync.run(teacher, {
        courseId: f.courseId,
        cohortId,
        roleId: f.roles.coursecreator!,
      }),
    ).rejects.toThrow();

    // a course manager (assigned by an admin) cannot be demoted by the teacher
    await enrolUsers.run(admin, {
      courseId: f.courseId,
      userIds: [f.users.manager!],
      roleId: f.roles.manager!,
    });
    await expect(
      setCourseRoles.run(teacher, {
        courseId: f.courseId,
        userId: f.users.manager!,
        roleIds: [f.roles.student!],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await t.db.roleAssignment.count({
        where: { userId: f.users.manager!, contextId: f.courseId, roleId: f.roles.manager! },
      }),
    ).toBe(1);
    // but can change roles they control
    await setCourseRoles.run(teacher, {
      courseId: f.courseId,
      userId: f.users.student2!,
      roleIds: [f.roles.teacher!],
    });
    const roles = await t.db.roleAssignment.findMany({
      where: { userId: f.users.student2!, contextId: f.courseId },
    });
    expect(roles.map((r) => r.roleId)).toEqual([f.roles.teacher!]);
  });

  it('site roles: unknown users and the assign rules are enforced', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await expect(
      assignSystemRole.run(admin, {
        userId: '0190a8f0-0000-7000-8000-000000000999',
        roleId: f.roles.manager!,
        assigned: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // a course creator given role:assign still cannot hand out the manager role
    await t.db.roleCapability.create({
      data: {
        roleId: f.roles.coursecreator!,
        capability: 'role:assign',
        permission: 'ALLOW',
      },
    });
    try {
      await assignSystemRole.run(admin, {
        userId: f.users.teacher!,
        roleId: f.roles.coursecreator!,
        assigned: true,
      });
      const creator = await ctxFor(t.db, f.users.teacher!);
      await expect(
        assignSystemRole.run(creator, {
          userId: f.users.teacher!,
          roleId: f.roles.manager!,
          assigned: true,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await t.db.roleCapability.deleteMany({
        where: { roleId: f.roles.coursecreator!, capability: 'role:assign' },
      });
      await t.db.roleAssignment.deleteMany({
        where: { userId: f.users.teacher!, contextId: SYSTEM_CONTEXT_ID },
      });
    }
  });

  it('leaving a group or the course also leaves the group chat', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id: groupId } = await createGroup.run(teacher, { courseId: f.courseId, name: 'Чат' });
    await setGroupMembers.run(teacher, {
      groupId,
      add: [f.users.student2!, f.users.student3!],
    });
    const { id: chatId } = await openGroupChat.run(await ctxFor(t.db, f.users.student2!), {
      groupId,
    });
    const active = async () =>
      (
        await t.db.conversationMember.findMany({
          where: { conversationId: chatId, leftAt: null },
          select: { userId: true },
        })
      ).map((m) => m.userId);
    expect(await active()).toEqual(expect.arrayContaining([f.users.student2!, f.users.student3!]));
    await setGroupMembers.run(teacher, { groupId, remove: [f.users.student3!] });
    expect(await active()).not.toContain(f.users.student3!);

    // student2 holds a manual and a self enrolment; leaving the self one keeps the course
    await unenrolSelf.run(await ctxFor(t.db, f.users.student2!), { courseId: f.courseId });
    expect(await active()).toContain(f.users.student2!);
    await t.db.enrolment.deleteMany({ where: { courseId: f.courseId, userId: f.users.student2! } });
  });
});
