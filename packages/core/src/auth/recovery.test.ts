import { createOTP } from '@better-auth/utils/otp';
import { symmetricEncrypt } from 'better-auth/crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { getEnv } from '../env.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { createUser } from '../users/users.ts';
import { createAuth } from './auth.ts';
import {
  addRecoveryPassphrase,
  deleteRecoveryPassphrase,
  listRecoveryPassphrases,
  normalizePassphrase,
  passphraseProblems,
} from './recovery.ts';

describe('passphrase rules', () => {
  it('ignores case, spacing and Unicode forms', () => {
    expect(normalizePassphrase('  Красная  Лиса\tпрыгает ')).toBe('красная лиса прыгает');
  });
  it('wants four words and twenty characters', () => {
    expect(passphraseProblems('one two three').map(String)).toEqual([
      'At least 4 words',
      'At least 20 characters',
    ]);
    expect(passphraseProblems('correct horse battery staple').map(String)).toEqual([]);
  });
});

describe('recovery passphrases', () => {
  const t = useTestDb();
  let auth: ReturnType<typeof createAuth>;
  let userId: string;
  const PHRASE = 'Correct horse battery staple';

  beforeAll(async () => {
    auth = createAuth({ db: t.db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
    ({ id: userId } = await createUser.run(await ctxFor(t.db, 'admin@test.local'), {
      email: 'phrase@example.org',
      firstName: 'Ph',
      lastName: 'Rase',
      password: 'Phrase-pass-1',
    }));
  });

  const cookiesOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  const startSignIn = async () => {
    const r = await auth.api.signInEmail({
      body: { email: 'phrase@example.org', password: 'Phrase-pass-1' },
      asResponse: true,
    });
    expect(await r.clone().json()).toMatchObject({ twoFactorRedirect: true });
    return new Headers({ cookie: cookiesOf(r) });
  };
  const usePhrase = (headers: Headers, passphrase: string) =>
    auth.api.verifyRecoveryPassphrase({ body: { passphrase }, headers, asResponse: true });

  it('can be added only with two-factor on and the current password', async () => {
    const ctx = await ctxFor(t.db, userId);
    const input = { name: 'Safe', passphrase: PHRASE, password: 'Phrase-pass-1' };
    await expect(addRecoveryPassphrase.run(ctx, input)).rejects.toMatchObject({
      fieldErrors: { passphrase: ['Turn on two-factor authentication first'] },
    });
    // enrol as the settings page does, then mark it verified
    const login = await auth.api.signInEmail({
      body: { email: 'phrase@example.org', password: 'Phrase-pass-1' },
      asResponse: true,
    });
    await auth.api.enableTwoFactor({
      body: { password: 'Phrase-pass-1' },
      headers: new Headers({ cookie: cookiesOf(login) }),
    });
    await t.db.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
    await t.db.twoFactor.updateMany({ where: { userId }, data: { verified: true } });

    await expect(
      addRecoveryPassphrase.run(ctx, { ...input, password: 'wrong' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      addRecoveryPassphrase.run(ctx, { ...input, passphrase: 'too short' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await addRecoveryPassphrase.run(ctx, input);
    await addRecoveryPassphrase.run(ctx, {
      ...input,
      name: 'Wallet',
      passphrase: 'another phrase kept in my wallet',
    });
    expect((await listRecoveryPassphrases(ctx)).map((p) => p.name)).toEqual(['Safe', 'Wallet']);
    const stored = await t.db.recoveryPassphrase.findFirstOrThrow({ where: { name: 'Safe' } });
    expect(stored.hash).not.toContain('horse');

    // not from a "log in as" session
    const as = {
      ...ctx,
      actor: { kind: 'user' as const, userId, isSiteAdmin: false, realUserId: 'x' },
    };
    await expect(listRecoveryPassphrases(as)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('take a code from the app instead of a password when the account has none', async () => {
    // someone who signs in through single sign-on: no password here
    const sso = await t.db.user.create({
      data: { email: 'sso@example.org', name: 'S O', firstName: 'S', lastName: 'O' },
    });
    await t.db.account.create({
      data: { userId: sso.id, providerId: 'keycloak', accountId: 'k1' },
    });
    const totp = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await t.db.twoFactor.create({
      data: {
        userId: sso.id,
        secret: await symmetricEncrypt({ key: getEnv().APP_SECRET, data: totp }),
        backupCodes: '[]',
        verified: true,
      },
    });
    await t.db.user.update({ where: { id: sso.id }, data: { twoFactorEnabled: true } });
    const ctx = await ctxFor(t.db, sso.id);
    const input = { name: 'Safe', passphrase: PHRASE, password: '' };
    await expect(
      addRecoveryPassphrase.run(ctx, { ...input, code: '000000' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const code = await createOTP(totp, { period: 30, digits: 6 }).totp();
    await addRecoveryPassphrase.run(ctx, { ...input, code });
    expect((await listRecoveryPassphrases(ctx)).map((p) => p.name)).toEqual(['Safe']);
  });

  it('signs in once instead of a code and emails the owner', async () => {
    const headers = await startSignIn();
    const bad = await usePhrase(headers, 'not my phrase at all, sorry');
    expect(bad.status).toBe(401);
    const failures = await t.db.twoFactor.findFirstOrThrow({ where: { userId } });
    expect(failures.failedVerificationCount).toBe(1);

    capturedJobs.length = 0;
    const ok = await usePhrase(headers, '  CORRECT horse   battery staple ');
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().join()).toContain('session_token');
    expect(
      capturedJobs.some(
        (j) => j.name === 'email.send' && (j.data as { to: string }).to === 'phrase@example.org',
      ),
    ).toBe(true);
    expect(await t.db.recoveryPassphrase.count({ where: { userId } })).toBe(1);
    expect(
      (await t.db.twoFactor.findFirstOrThrow({ where: { userId } })).failedVerificationCount,
    ).toBe(0);

    // used up, and the pending sign-in is finished
    expect((await usePhrase(await startSignIn(), PHRASE)).status).toBe(401);
    expect((await usePhrase(headers, 'another phrase kept in my wallet')).status).toBe(401);
  });

  it('go when two-factor authentication is turned off', async () => {
    const ctx = await ctxFor(t.db, userId);
    const [wallet] = await listRecoveryPassphrases(ctx);
    await deleteRecoveryPassphrase.run(ctx, { id: wallet!.id });
    expect(await listRecoveryPassphrases(ctx)).toEqual([]);
    await addRecoveryPassphrase.run(ctx, {
      name: 'Again',
      passphrase: PHRASE,
      password: 'Phrase-pass-1',
    });
    await addRecoveryPassphrase.run(ctx, {
      name: 'Spare',
      passphrase: 'a spare phrase in the drawer',
      password: 'Phrase-pass-1',
    });
    const headers = await startSignIn();
    const ok = await usePhrase(headers, PHRASE);
    expect(await t.db.recoveryPassphrase.count({ where: { userId } })).toBe(1);
    await auth.api.disableTwoFactor({
      body: { password: 'Phrase-pass-1' },
      headers: new Headers({ cookie: cookiesOf(ok) }),
    });
    expect(await t.db.recoveryPassphrase.count({ where: { userId } })).toBe(0);
  });
});
