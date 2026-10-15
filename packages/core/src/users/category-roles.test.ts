import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { invalidatePermissionCaches } from '../access/permissions.ts';
import { createCategory } from '../courses/categories.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { assignCategoryRole, categoryRoleHolders } from './users.ts';

describe('roles given in a category', () => {
  const t = useTestDb();

  it('hold for what lies in the category, and only roles meant for categories', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id: faculty } = await createCategory.run(admin, { name: 'Факультет' });
    const { id: inside } = await createCategory.run(admin, { name: 'Кафедра', parentId: faculty });
    const { id: elsewhere } = await createCategory.run(admin, { name: 'Другой факультет' });
    const roles = Object.fromEntries((await t.db.role.findMany()).map((r) => [r.shortName, r.id]));
    const teacher = await t.db.user.findFirstOrThrow({ where: { username: 'teacher' } });
    const can = async (where: string) =>
      (await ctxFor(t.db, teacher.id)).perm.can('course:create', where);
    expect(await can(inside)).toBe(false);

    await assignCategoryRole.run(admin, {
      categoryId: faculty,
      userId: teacher.id,
      roleId: roles.coursecreator!,
      assigned: true,
    });
    invalidatePermissionCaches();
    expect(await can(faculty)).toBe(true);
    expect(await can(inside)).toBe(true);
    expect(await can(elsewhere)).toBe(false);
    const holders = await categoryRoleHolders(admin, faculty);
    expect(
      holders.find((h) => h.role.shortName === 'coursecreator')!.users.map((u) => u.id),
    ).toEqual([teacher.id]);

    // a course role is not given in a category, and a teacher gives no roles there
    await expect(
      assignCategoryRole.run(admin, {
        categoryId: faculty,
        userId: teacher.id,
        roleId: roles.student!,
        assigned: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      assignCategoryRole.run(await ctxFor(t.db, teacher.id), {
        categoryId: faculty,
        userId: teacher.id,
        roleId: roles.manager!,
        assigned: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await assignCategoryRole.run(admin, {
      categoryId: faculty,
      userId: teacher.id,
      roleId: roles.coursecreator!,
      assigned: false,
    });
    invalidatePermissionCaches();
    expect(await can(inside)).toBe(false);
  });
});
