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
