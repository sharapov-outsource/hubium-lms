import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { acceptPolicies, publishPolicyVersion, savePolicy } from '../privacy/privacy.ts';
import { setSettings } from '../settings/settings.ts';
import { accountGate } from './gate.ts';

describe('account gate', () => {
  const t = useTestDb();
  const gateOf = async (username: string) =>
    accountGate(t.db, await t.db.user.findUniqueOrThrow({ where: { username } }));

  it('names the step to take first: policies, then the password, then two-factor sign-in', async () => {
    expect(await gateOf('teacher')).toBeNull();

    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id } = await savePolicy.run(admin, { key: 'terms', name: { ru: 'Правила', en: '' } });
    await publishPolicyVersion.run(admin, { policyId: id, content: { ru: 'Текст', en: '' } });
    await t.db.user.update({ where: { username: 'teacher' }, data: { mustChangePassword: true } });
    expect(await gateOf('teacher')).toBe('POLICIES');

    const teacher = await t.db.user.findUniqueOrThrow({ where: { username: 'teacher' } });
    const version = await t.db.policyVersion.findFirstOrThrow({ where: { policyId: id } });
    await acceptPolicies(await ctxFor(t.db, teacher.id), [version.id]);
    expect(await gateOf('teacher')).toBe('PASSWORD');
    await t.db.user.update({ where: { id: teacher.id }, data: { mustChangePassword: false } });
    expect(await gateOf('teacher')).toBeNull();

    // administrators, when the site requires it
    const site = await t.db.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } });
    await acceptPolicies(admin, [version.id]);
    expect(await accountGate(t.db, site)).toBeNull();
    await setSettings(t.db, { 'auth.require2faForAdmins': true });
    try {
      expect(await accountGate(t.db, site)).toBe('TWO_FACTOR');
      expect(await accountGate(t.db, { ...site, twoFactorEnabled: true })).toBeNull();
      expect(await gateOf('teacher')).toBeNull();
    } finally {
      await setSettings(t.db, { 'auth.require2faForAdmins': false });
    }
  });
});
