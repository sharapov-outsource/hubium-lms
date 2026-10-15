import { Client } from 'ldapts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { createUser } from '../users/users.ts';
import { createAuth } from './auth.ts';
import {
  checkLdapPassword,
  escapeFilterValue,
  getLdapServer,
  saveLdapServer,
  signInWithLdap,
  syncLdapUsers,
  testLdapConnection,
} from './ldap.ts';

// Against the directory of e2e/ldap (CI starts OpenLDAP and sets LDAP_TEST_URL).
const URL = process.env.LDAP_TEST_URL;

describe('the LDAP tests', () => {
  // they need a directory and skip without one: CI has one, and must not skip them quietly
  it.runIf(!!process.env.CI)('run in CI', () => {
    expect(URL, 'CI starts OpenLDAP: pass LDAP_TEST_URL to the tests').toBeTruthy();
  });
});

describe('escapeFilterValue', () => {
  it('escapes filter syntax (RFC 4515)', () => {
    expect(escapeFilterValue('a*)(uid=*')).toBe('a\\2a\\29\\28uid=\\2a');
    expect(escapeFilterValue('back\\slash')).toBe('back\\5cslash');
  });
});

describe.skipIf(!URL)('LDAP sign-in', () => {
  const t = useTestDb();
  let auth: ReturnType<typeof createAuth>;
  const opts = { appUrl: 'http://lms.test' };

  beforeAll(async () => {
    auth = createAuth({ db: t.db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
    await t.db.userProfileField.create({
      data: { shortName: 'department', name: { ru: 'Факультет' }, type: 'text' },
    });
    await saveLdapServer.run(await ctxFor(t.db, 'admin@test.local'), {
      enabled: true,
      url: URL!,
      bindDn: 'cn=admin,dc=hubium,dc=test',
      bindPassword: 'ldap-admin',
      baseDn: 'ou=people,dc=hubium,dc=test',
      userFilter: '(&(objectClass=inetOrgPerson)(uid={login}))',
      loginAttribute: 'uid',
      idAttribute: 'entryUUID',
      mapping: { fields: { department: 'departmentNumber' } },
      autoCreate: false,
      linkByEmail: true,
      suspendMissing: true,
    });
  });

  it('checks passwords with a bind and never binds anonymously', async () => {
    const s = (await getLdapServer(t.db))!;
    expect((await checkLdapPassword(s, 'lena', 'Ldap-pass-123')).status).toBe('ok');
    expect((await checkLdapPassword(s, 'lena', 'wrong')).status).toBe('invalid');
    expect((await checkLdapPassword(s, 'lena', '')).status).toBe('unknown');
    expect((await checkLdapPassword(s, 'nobody', 'x')).status).toBe('unknown');
    expect((await checkLdapPassword(s, '*', 'Ldap-pass-123')).status).toBe('unknown');
    const test = await testLdapConnection(await ctxFor(t.db, 'admin@test.local'), 'oleg');
    expect(test).toMatchObject({
      ok: true,
      person: { email: 'oleg@example.org', lastName: 'Орлов' },
    });
  });

  it('creates accounts only when allowed, links existing ones, follows the directory', async () => {
    expect(await signInWithLdap(t.db, 'oleg', 'Ldap-pass-123', opts)).toMatchObject({
      kind: 'refused',
      code: 'LDAP_NO_ACCOUNT',
    });
    // unknown in the directory: the form tries the local password
    expect(await signInWithLdap(t.db, 'admin', 'x', opts)).toEqual({ kind: 'fallback' });

    // an existing account with the same email is linked
    const { id } = await createUser.run(await ctxFor(t.db, 'admin@test.local'), {
      email: 'lena@example.org',
      firstName: 'L',
      lastName: 'L',
      password: 'Local-pass-1',
    });
    expect(await signInWithLdap(t.db, 'Lena', 'Ldap-pass-123', opts)).toEqual({
      kind: 'user',
      userId: id,
    });
    const lena = await t.db.user.findUniqueOrThrow({ where: { id } });
    expect(lena.name).toBe('Лена Лебедева');
    expect(lena.customFields).toMatchObject({ department: 'Матфак' });
    // she also has a local password, so a wrong one falls back to it
    expect(await signInWithLdap(t.db, 'lena', 'wrong', opts)).toEqual({ kind: 'fallback' });

    await t.db.ldapServer.update({ where: { id: 'default' }, data: { autoCreate: true } });
    const oleg = await signInWithLdap(t.db, 'oleg', 'Ldap-pass-123', opts);
    expect(oleg.kind).toBe('user');
    const created = await t.db.user.findUniqueOrThrow({
      where: { id: (oleg as { userId: string }).userId },
    });
    expect(created).toMatchObject({ username: 'oleg', email: 'oleg@example.org' });
    // no local password: a wrong one is refused here and counted
    expect(await signInWithLdap(t.db, 'oleg', 'wrong', opts)).toMatchObject({
      kind: 'refused',
      code: 'INVALID_LOGIN',
    });
  });

  it('links no administrator, nobody ambiguous, and checks the lockout before the directory', async () => {
    // the directory's "gone" has the email of one account and the login of another
    const admin = await ctxFor(t.db, 'admin@test.local');
    const byEmail = await createUser.run(admin, {
      email: 'gone@example.org',
      firstName: 'G',
      lastName: 'E',
      password: 'Local-pass-1',
    });
    const byLogin = await createUser.run(admin, {
      email: 'someone@example.org',
      username: 'gone',
      firstName: 'G',
      lastName: 'L',
      password: 'Local-pass-1',
    });
    expect(await signInWithLdap(t.db, 'gone', 'Ldap-pass-123', opts)).toMatchObject({
      kind: 'refused',
      code: 'LDAP_ACCOUNT_AMBIGUOUS',
    });
    await t.db.user.delete({ where: { id: byLogin.id } });
    await t.db.user.update({ where: { id: byEmail.id }, data: { isSiteAdmin: true } });
    expect(await signInWithLdap(t.db, 'gone', 'Ldap-pass-123', opts)).toMatchObject({
      kind: 'refused',
      code: 'LDAP_ACCOUNT_NOT_LINKED',
    });
    expect(await t.db.account.count({ where: { userId: byEmail.id, providerId: 'ldap' } })).toBe(0);
    await t.db.user.delete({ where: { id: byEmail.id } });

    // a locked account: the directory is not asked, so its own lockout policy is not fed
    const lena = await t.db.user.findUniqueOrThrow({ where: { email: 'lena@example.org' } });
    await t.db.user.update({
      where: { id: lena.id },
      data: { lockedUntil: new Date(Date.now() + 3_600_000) },
    });
    const bind = vi.spyOn(Client.prototype, 'bind');
    try {
      expect(await signInWithLdap(t.db, 'lena', 'wrong', opts)).toMatchObject({
        kind: 'refused',
        code: 'ACCOUNT_LOCKED',
      });
      expect(bind.mock.calls.map(([dn]) => dn)).not.toContain(
        'uid=lena,ou=people,dc=hubium,dc=test',
      );
    } finally {
      bind.mockRestore();
      await t.db.user.update({ where: { id: lena.id }, data: { lockedUntil: null } });
    }
  });

  it('signs in through Better Auth, with the two-factor challenge when it is on', async () => {
    const r = await auth.api.signInLdap({
      body: { login: 'oleg', password: 'Ldap-pass-123' },
      asResponse: true,
    });
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().join()).toContain('session_token');
    await t.db.user.update({ where: { username: 'oleg' }, data: { twoFactorEnabled: true } });
    const challenge = await auth.api.signInLdap({
      body: { login: 'oleg', password: 'Ldap-pass-123' },
      asResponse: true,
    });
    expect(await challenge.json()).toEqual({ twoFactorRedirect: true });
    expect(challenge.headers.getSetCookie().join()).toContain('two_factor');
    await expect(
      auth.api.signInLdap({ body: { login: 'nobody', password: 'x' } }),
    ).rejects.toMatchObject({ body: { code: 'LDAP_FALLBACK' } });
  });

  it('the nightly sync suspends accounts the directory lost', async () => {
    await t.db.ldapServer.update({ where: { id: 'default' }, data: { autoCreate: true } });
    await signInWithLdap(t.db, 'gone', 'Ldap-pass-123', opts);
    const gone = await t.db.user.findUniqueOrThrow({ where: { username: 'gone' } });
    // the directory forgets her
    await t.db.account.updateMany({
      where: { userId: gone.id, providerId: 'ldap' },
      data: { accountId: 'no-longer-there' },
    });
    await t.db.user.update({ where: { id: gone.id }, data: { username: 'gone-away' } });
    const r = await syncLdapUsers(t.db);
    expect(r).toMatchObject({ suspended: 1, errors: 0 });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: gone.id } })).status).toBe(
      'SUSPENDED',
    );
  });
});
