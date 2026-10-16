import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { invalidatePermissionCaches } from '../access/permissions.ts';
import { ValidationError } from '../errors.ts';
import { activityRoleHolders, assignActivityRole } from './users.ts';

describe('roles given in an activity', () => {
  const t = useTestDb();

  it('hold in that activity alone, for people of its course', async () => {
    const f = await courseFixture(t.db, 'ACTROLE');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const forum = await f.addActivity('forum', 'Обсуждения', {});
    const other = await f.addActivity('forum', 'Другой форум', {});
    const s1 = f.users.student1!;
    const can = async (where: string) =>
      (await ctxFor(t.db, s1)).perm.can('mod.forum:moderate', where);
    expect(await can(forum.id)).toBe(false);

    // the course's teacher makes a learner a teacher of this forum
    await assignActivityRole.run(teacher, {
      activityId: forum.id,
      userId: s1,
      roleId: f.roles.teacher!,
      assigned: true,
    });
    invalidatePermissionCaches();
    expect(await can(forum.id)).toBe(true);
    expect(await can(other.id)).toBe(false);
    const holders = await activityRoleHolders(teacher, forum.id);
    expect(holders.find((h) => h.role.shortName === 'teacher')!.users.map((u) => u.id)).toEqual([
      s1,
    ]);

    // not a role meant for activities, nor someone outside the course
    await expect(
      assignActivityRole.run(teacher, {
        activityId: forum.id,
        userId: s1,
        roleId: f.roles.coursecreator!,
        assigned: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const outsider = await t.db.user.findFirstOrThrow({ where: { username: 'manager' } });
    await expect(
      assignActivityRole.run(teacher, {
        activityId: forum.id,
        userId: outsider.id,
        roleId: f.roles.student!,
        assigned: true,
      }),
    ).rejects.toMatchObject({ fieldErrors: { userId: [expect.any(String)] } });

    // taken back
    await assignActivityRole.run(teacher, {
      activityId: forum.id,
      userId: s1,
      roleId: f.roles.teacher!,
      assigned: false,
    });
    invalidatePermissionCaches();
    expect(await can(forum.id)).toBe(false);
  });
});
