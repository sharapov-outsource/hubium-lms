import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { setSettings } from '../settings/settings.ts';
import { createUser, unlockUser } from '../users/users.ts';
import { createAuth } from './auth.ts';
import { unlockWithToken } from './lockout.ts';

describe('account lockout', () => {
  const t = useTestDb();
  let auth: ReturnType<typeof createAuth>;
  let userId: string;

  beforeAll(async () => {
    auth = createAuth({ db: t.db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
    const ctx = await ctxFor(t.db, 'admin@test.local');
    ({ id: userId } = await createUser.run(ctx, {
      email: 'locky@example.org',
      username: 'locky',
      firstName: 'Lo',
      lastName: 'Cky',
      password: 'Right-pass-1',
    }));
  });
  afterEach(async () => {
    await setSettings(t.db, { 'lockout.threshold': 0 });
    await t.db.user.update({
      where: { id: userId },
      data: { lockedUntil: null, failedLoginCount: 0, failedLoginAt: null },
    });
  });

  const signIn = (password: string, by: 'email' | 'username' = 'email') =>
    by === 'email'
      ? auth.api.signInEmail({ body: { email: 'locky@example.org', password } })
      : auth.api.signInUsername({ body: { username: 'locky', password } });

  it('never locks while the threshold is 0', async () => {
    for (let i = 0; i < 6; i++) await expect(signIn('wrong')).rejects.toMatchObject({});
    expect((await signIn('Right-pass-1')).token).toEqual(expect.any(String));
  });

  it('locks after the threshold, refuses even the right password, mails an unlock link', async () => {
    await setSettings(t.db, { 'lockout.threshold': 3, 'lockout.durationMinutes': 15 });
    capturedJobs.length = 0;
    await expect(signIn('wrong')).rejects.toMatchObject({ statusCode: 401 });
    await expect(signIn('wrong', 'username')).rejects.toMatchObject({ statusCode: 401 });
    // a success in between starts the count again
    await signIn('Right-pass-1');
    await expect(signIn('wrong')).rejects.toMatchObject({ statusCode: 401 });
    await expect(signIn('wrong')).rejects.toMatchObject({ statusCode: 401 });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: userId } })).lockedUntil).toBeNull();
    await expect(signIn('wrong', 'username')).rejects.toMatchObject({ statusCode: 401 });

    const u = await t.db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    await expect(signIn('Right-pass-1')).rejects.toMatchObject({
      statusCode: 403,
      body: { code: 'ACCOUNT_LOCKED' },
    });
    expect(
      await t.db.eventLog.count({ where: { name: 'user.locked', relatedUserId: userId } }),
    ).toBe(1);

    const mail = capturedJobs.find(
      (j) => j.name === 'email.send' && (j.data as { to: string }).to === 'locky@example.org',
    );
    const token = /unlock-account\?token=([\w-]+)/.exec((mail!.data as { text: string }).text)![1]!;
    expect(await unlockWithToken(t.db, 'nope')).toBe(false);
    expect(await unlockWithToken(t.db, token)).toBe(true);
    expect((await signIn('Right-pass-1')).token).toEqual(expect.any(String));
    // the link works once
    expect(await unlockWithToken(t.db, token)).toBe(false);
  });

  it('administrators unlock from the user page', async () => {
    await setSettings(t.db, { 'lockout.threshold': 1 });
    await expect(signIn('wrong')).rejects.toMatchObject({ statusCode: 401 });
    await expect(signIn('Right-pass-1')).rejects.toMatchObject({ statusCode: 403 });
    await unlockUser.run(await ctxFor(t.db, 'admin@test.local'), { id: userId });
    expect((await signIn('Right-pass-1')).token).toEqual(expect.any(String));
  });
});
