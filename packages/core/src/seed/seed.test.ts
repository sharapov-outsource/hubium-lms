import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { deleteUser } from '../users/users.ts';
import { seed } from './seed.ts';

describe('seed', () => {
  const t = useTestDb();
  const again = () =>
    seed(t.db, {
      profile: 'demo',
      courses: false,
      adminEmail: 'admin@test.local',
      adminPassword: 'Admin12345!',
    });

  it('puts the demo in once: deleted demo accounts stay deleted', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const manager = await t.db.user.findFirstOrThrow({ where: { username: 'manager' } });
    await deleteUser.run(admin, { id: manager.id });
    // every start and upgrade runs the seed again
    expect((await again()).demoUsers).toBe(0);
    expect(await t.db.user.count({ where: { email: 'manager@hubium.local' } })).toBe(0);
    const managerRole = await t.db.role.findUniqueOrThrow({ where: { shortName: 'manager' } });
    expect(
      await t.db.roleAssignment.count({
        where: { roleId: managerRole.id, contextId: SYSTEM_CONTEXT_ID, user: { deletedAt: null } },
      }),
    ).toBe(0);
  });

  it('counts a site seeded before the mark as seeded', async () => {
    await t.db.siteSetting.delete({ where: { key: 'seed.demo' } });
    expect((await again()).demoUsers).toBe(0);
    expect(await t.db.user.count({ where: { email: 'manager@hubium.local' } })).toBe(0);
  });
});
