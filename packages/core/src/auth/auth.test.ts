import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '../../test/helpers.ts';
import { setSettings } from '../settings/settings.ts';
import { createAuth } from './auth.ts';

describe('auth', () => {
  const t = useTestDb();
  let auth: ReturnType<typeof createAuth>;

  beforeAll(() => {
    process.env.AUTH_GOOGLE_ID = 'google-id';
    process.env.AUTH_GOOGLE_SECRET = 'google-secret';
    auth = createAuth({ db: t.db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
  });
  afterAll(() => {
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
  });

  const google = () =>
    auth.api.signInSocial({ body: { provider: 'google', callbackURL: '/dashboard' } });

  it('honours the OAuth switches even when provider keys are configured', async () => {
    await setSettings(t.db, { 'auth.oauth.google': false });
    await expect(google()).rejects.toMatchObject({ statusCode: 403 });
    await setSettings(t.db, { 'auth.oauth.google': true });
    try {
      expect(await google()).toMatchObject({ url: expect.stringContaining('accounts.google.com') });
    } finally {
      await setSettings(t.db, { 'auth.oauth.google': false });
    }
  });

  it('changes profiles only through Hubium, and sign-up takes only the form fields', async () => {
    const signIn = await auth.api.signInEmail({
      body: { email: 'student1@hubium.local', password: 'Demo12345!' },
      returnHeaders: true,
    });
    const headers = new Headers({
      cookie: signIn.headers
        .getSetCookie()
        .map((l) => l.split(';')[0])
        .join('; '),
    });
    const before = await t.db.user.findFirstOrThrow({ where: { email: 'student1@hubium.local' } });
    // a username of someone in the directory, a broken time zone, an outside avatar
    await expect(
      auth.api.updateUser({
        body: { username: 'teacher', timezone: 'Not/AZone', image: 'https://evil.test/t.png' },
        headers,
      } as never),
    ).rejects.toMatchObject({ statusCode: 404 });
    const after = await t.db.user.findFirstOrThrow({ where: { id: before.id } });
    expect([after.username, after.timezone, after.image]).toEqual([
      before.username,
      before.timezone,
      before.image,
    ]);

    await setSettings(t.db, {
      'registration.enabled': true,
      'registration.requireEmailVerification': false,
    });
    const signUp = (body: Record<string, unknown>) =>
      auth.api.signUpEmail({
        body: { email: 'newbie@example.org', password: 'Secret12345!', name: 'New Bie', ...body },
      } as never) as unknown as Promise<{ token: string | null }>;
    try {
      for (const extra of [
        { username: 'teacher' },
        { image: 'https://evil.test/t.png' },
        { timezone: 'Not/AZone' },
        { firstName: '' },
        { lastName: 'x'.repeat(101) },
        { locale: '<script>' },
      ])
        await expect(signUp(extra)).rejects.toMatchObject({ statusCode: 400 });
      expect(await t.db.user.count({ where: { email: 'newbie@example.org' } })).toBe(0);
      // what the registration form sends goes through
      const ok = await signUp({ firstName: 'New', lastName: 'Bie', locale: 'ru' });
      expect(ok.token).toEqual(expect.any(String));
    } finally {
      await setSettings(t.db, {
        'registration.enabled': false,
        'registration.requireEmailVerification': true,
      });
    }
  });

  it('follows the "require email verification" setting', async () => {
    const signUp = (email: string) =>
      auth.api.signUpEmail({ body: { email, password: 'Secret12345!', name: 'Ann Lee' } });
    const signIn = (email: string) =>
      auth.api.signInEmail({ body: { email, password: 'Secret12345!' } });
    await setSettings(t.db, { 'registration.enabled': true });
    try {
      await setSettings(t.db, { 'registration.requireEmailVerification': true });
      expect((await signUp('strict@example.org')).token).toBeNull();
      await expect(signIn('strict@example.org')).rejects.toMatchObject({
        body: { code: 'EMAIL_NOT_VERIFIED' },
      });

      await setSettings(t.db, { 'registration.requireEmailVerification': false });
      expect((await signUp('relaxed@example.org')).token).toEqual(expect.any(String));
      expect((await signIn('relaxed@example.org')).token).toEqual(expect.any(String));
      // the switch also lets in people who registered while it was on
      expect((await signIn('strict@example.org')).token).toEqual(expect.any(String));
    } finally {
      await setSettings(t.db, {
        'registration.enabled': false,
        'registration.requireEmailVerification': true,
      });
    }
  });
});
