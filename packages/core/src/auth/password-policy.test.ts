import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ValidationError } from '../errors.ts';
import { defaultSettings, setSettings } from '../settings/settings.ts';
import { bulkUploadUsers, createUser, updateUser } from '../users/users.ts';
import { createAuth } from './auth.ts';
import { passwordExpired, passwordPolicy, passwordProblems } from './password-policy.ts';

describe('passwordProblems', () => {
  const base = passwordPolicy(defaultSettings());

  it('allows any 8 characters by default', () => {
    expect(passwordProblems(base, 'abcdefgh')).toEqual([]);
    expect(passwordProblems(base, 'abcdefg')).toEqual(['At least 8 characters']);
  });

  it('checks each character class, in any script', () => {
    const strict = {
      ...base,
      minLength: 10,
      requireDigit: true,
      requireLower: true,
      requireUpper: true,
      requireSymbol: true,
    };
    expect(passwordProblems(strict, 'abcdefghij')).toEqual([
      'Include a digit',
      'Include an uppercase letter',
      'Include a symbol such as ! or %',
    ]);
    expect(passwordProblems(strict, 'Пароль-2026')).toEqual([]);
    expect(passwordProblems(strict, 'Aa1!')).toEqual(['At least 10 characters']);
  });

  it('expires passwords only when a lifetime is set', () => {
    const now = new Date('2026-10-16T00:00:00Z');
    const old = new Date('2026-07-01T00:00:00Z');
    expect(passwordExpired(base, old, now)).toBe(false);
    expect(passwordExpired({ ...base, maxAgeDays: 90 }, old, now)).toBe(true);
    expect(passwordExpired({ ...base, maxAgeDays: 120 }, old, now)).toBe(false);
    expect(passwordExpired({ ...base, maxAgeDays: 90 }, null, now)).toBe(false);
  });
});

describe('password policy', () => {
  const t = useTestDb();
  let auth: ReturnType<typeof createAuth>;

  beforeAll(() => {
    auth = createAuth({ db: t.db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
  });
  afterEach(async () => {
    const d = defaultSettings();
    await setSettings(t.db, {
      'password.minLength': d['password.minLength'],
      'password.requireDigit': false,
      'password.requireSymbol': false,
      'password.history': 0,
      'password.maxAgeDays': 0,
      'registration.enabled': false,
      'registration.requireEmailVerification': true,
    });
  });

  it('applies to admin forms and CSV upload', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    await setSettings(t.db, { 'password.minLength': 12, 'password.requireSymbol': true });
    await expect(
      createUser.run(ctx, {
        email: 'weak@example.org',
        firstName: 'W',
        lastName: 'K',
        password: 'Password123',
      }),
    ).rejects.toMatchObject({
      fieldErrors: { password: ['At least 12 characters', 'Include a symbol such as ! or %'] },
    });
    const { id } = await createUser.run(ctx, {
      email: 'strong@example.org',
      firstName: 'S',
      lastName: 'G',
      password: 'Password123!',
    });
    const user = await t.db.user.findUniqueOrThrow({ where: { id } });
    expect(user.passwordChangedAt).not.toBeNull();
    await expect(updateUser.run(ctx, { id, password: 'short!' })).rejects.toBeInstanceOf(
      ValidationError,
    );

    const r = await bulkUploadUsers.run(ctx, {
      csv: 'username,firstname,lastname,password\ncsvweak,A,B,Password123\ncsvok,C,D,Password123!!',
    });
    expect(r.created).toBe(1);
    expect(r.errors).toEqual([
      { line: 2, message: 'At least 12 characters; Include a symbol such as ! or %' },
    ]);
  });

  it('refuses recent passwords when history is on', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const { id } = await createUser.run(ctx, {
      email: 'reuse@example.org',
      firstName: 'R',
      lastName: 'U',
      password: 'First-pass-1',
    });
    await setSettings(t.db, { 'password.history': 2 });
    await updateUser.run(ctx, { id, password: 'Second-pass-2' });
    await expect(updateUser.run(ctx, { id, password: 'First-pass-1' })).rejects.toMatchObject({
      fieldErrors: { password: ['Choose a password you have not used recently'] },
    });
    await updateUser.run(ctx, { id, password: 'Third-pass-3' });
    // two remembered: the third and the second; the first may come back
    await updateUser.run(ctx, { id, password: 'First-pass-1' });
  });

  it('applies to Better Auth sign-up and password changes', async () => {
    await setSettings(t.db, {
      'registration.enabled': true,
      'registration.requireEmailVerification': false,
      'password.requireDigit': true,
      'password.history': 3,
    });
    await expect(
      auth.api.signUpEmail({
        body: { email: 'ba@example.org', password: 'no-digits-here', name: 'B A' },
      }),
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_POLICY', message: 'Include a digit' } });
    const { user } = await auth.api.signUpEmail({
      body: { email: 'ba@example.org', password: 'with-digit-1', name: 'B A' },
    });
    expect(
      (await t.db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordChangedAt,
    ).not.toBeNull();
    const cookie = await auth.api.signInEmail({
      body: { email: 'ba@example.org', password: 'with-digit-1' },
      asResponse: true,
    });
    const h = new Headers({ cookie: cookie.headers.get('set-cookie') ?? '' });
    await expect(
      auth.api.changePassword({
        body: { currentPassword: 'with-digit-1', newPassword: 'with-digit-1' },
        headers: h,
      }),
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_POLICY' } });
    await auth.api.changePassword({
      body: { currentPassword: 'with-digit-1', newPassword: 'another-2' },
      headers: h,
    });
    // the change is remembered, so it cannot be reused either
    expect(await t.db.passwordHistory.count({ where: { userId: user.id } })).toBe(2);
  });

  it('asks for a new password at sign-in once it has expired', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const { id } = await createUser.run(ctx, {
      email: 'old@example.org',
      firstName: 'O',
      lastName: 'D',
      password: 'Old-password-1',
    });
    await t.db.user.update({
      where: { id },
      data: { passwordChangedAt: new Date(Date.now() - 100 * 86_400_000) },
    });
    await auth.api.signInEmail({ body: { email: 'old@example.org', password: 'Old-password-1' } });
    expect((await t.db.user.findUniqueOrThrow({ where: { id } })).mustChangePassword).toBe(false);
    await setSettings(t.db, { 'password.maxAgeDays': 90 });
    await auth.api.signInEmail({ body: { email: 'old@example.org', password: 'Old-password-1' } });
    expect((await t.db.user.findUniqueOrThrow({ where: { id } })).mustChangePassword).toBe(true);
  });
});
