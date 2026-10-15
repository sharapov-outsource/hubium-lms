import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { invalidatePermissionCaches, usersWithCap } from './permissions.ts';

describe('users with a capability', () => {
  const t = useTestDb();

  it('leaves out whom can() refuses: a prohibiting role, a suspended enrolment', async () => {
    const f = await courseFixture(t.db, 'UWC');
    const submit = () => usersWithCap(t.db, 'mod.assign:submit', f.courseId);
    expect(await submit()).toContain(f.users.student1);

    // a second role that takes submitting away, as Moodle's "Suspended" does
    const off = await t.db.role.create({
      data: {
        shortName: 'nosubmit',
        name: { ru: 'Без сдачи', en: 'No submitting' },
        archetype: 'NONE',
        assignableLevels: ['COURSE'],
        capabilities: { create: { capability: 'mod.assign:submit', permission: 'PROHIBIT' } },
      },
    });
    await t.db.roleAssignment.create({
      data: { userId: f.users.student1!, roleId: off.id, contextId: f.courseId },
    });
    invalidatePermissionCaches('roles');
    const s1 = await ctxFor(t.db, f.users.student1!);
    expect(await s1.perm.can('mod.assign:submit', f.courseId)).toBe(false);
    expect(await submit()).not.toContain(f.users.student1);
    expect(await submit()).toContain(f.users.student2);

    // a teacher whose teaching enrolment is suspended, who also studies the course through
    // another enrolment: the active one gives no teaching role
    const student = await t.db.role.findUniqueOrThrow({ where: { shortName: 'student' } });
    const self = await t.db.enrolmentMethod.create({
      data: { courseId: f.courseId, type: 'SELF', roleId: student.id },
    });
    const studying = await t.db.enrolment.create({
      data: { methodId: self.id, courseId: f.courseId, userId: f.users.teacher! },
    });
    await t.db.roleAssignment.create({
      data: {
        userId: f.users.teacher!,
        roleId: student.id,
        contextId: f.courseId,
        enrolmentId: studying.id,
      },
    });
    const grade = () => usersWithCap(t.db, 'mod.assign:grade', f.courseId);
    expect(await grade()).toContain(f.users.teacher);
    await t.db.enrolment.updateMany({
      where: { courseId: f.courseId, userId: f.users.teacher!, id: { not: studying.id } },
      data: { status: 'SUSPENDED' },
    });
    expect(await grade()).not.toContain(f.users.teacher);
  });
});
