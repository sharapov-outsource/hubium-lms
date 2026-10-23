import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { listRoleOverrides, overridableCapabilities, setRoleOverride } from './admin.ts';

describe('permission overrides', () => {
  const t = useTestDb();

  it('offers the capabilities that apply at the context level', () => {
    const activity = overridableCapabilities('ACTIVITY', 'forum');
    expect(activity).toContain('mod.forum:post');
    expect(activity).not.toContain('mod.quiz:attempt');
    expect(activity).not.toContain('course:update');
    const course = overridableCapabilities('COURSE');
    expect(course).toEqual(expect.arrayContaining(['course:update', 'mod.quiz:attempt']));
    expect(course).not.toContain('site:config');
    expect(overridableCapabilities('CATEGORY')).toContain('category:manage');
  });

  it('applies a course override and logs it', async () => {
    const f = await courseFixture(t.db, 'OVR1');
    const forum = await f.addActivity('forum', 'Discussion', {});
    const manager = await ctxFor(t.db, 'manager@hubium.local');
    const student = () => ctxFor(t.db, f.users.student1!);
    expect(await (await student()).perm.can('mod.forum:post', forum.id)).toBe(true);

    await setRoleOverride.run(manager, {
      contextId: f.courseId,
      roleId: f.roles.student,
      capability: 'mod.forum:post',
      permission: 'DENY',
    });
    expect(await (await student()).perm.can('mod.forum:post', forum.id)).toBe(false);
    const listed = await listRoleOverrides(manager, f.courseId);
    expect(listed.level).toBe('COURSE');
    expect(listed.overrides).toEqual([
      { roleId: f.roles.student, capability: 'mod.forum:post', permission: 'DENY' },
    ]);
    const event = await t.db.eventLog.findFirstOrThrow({
      where: { name: 'role.override.changed', contextId: f.courseId },
    });
    expect(event.data).toMatchObject({ capability: 'mod.forum:post', permission: 'DENY' });

    await setRoleOverride.run(manager, {
      contextId: f.courseId,
      roleId: f.roles.student,
      capability: 'mod.forum:post',
      permission: 'INHERIT',
    });
    expect(await (await student()).perm.can('mod.forum:post', forum.id)).toBe(true);
  });

  it('refuses capabilities from another level and permissions the editor lacks', async () => {
    const f = await courseFixture(t.db, 'OVR2');
    const admin = await ctxFor(t.db, 'admin@test.local');
    await expect(
      setRoleOverride.run(admin, {
        contextId: f.courseId,
        roleId: f.roles.student,
        capability: 'site:config',
        permission: 'ALLOW',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // a teacher allowed to override still cannot hand out what they do not have
    await setRoleOverride.run(admin, {
      contextId: f.courseId,
      roleId: f.roles.editingteacher,
      capability: 'role:override',
      permission: 'ALLOW',
    });
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await expect(
      setRoleOverride.run(teacher, {
        contextId: f.courseId,
        roleId: f.roles.student,
        capability: 'user:loginas',
        permission: 'ALLOW',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await setRoleOverride.run(teacher, {
      contextId: f.courseId,
      roleId: f.roles.student,
      capability: 'mod.forum:startdiscussion',
      permission: 'PROHIBIT',
    });
  });
});
