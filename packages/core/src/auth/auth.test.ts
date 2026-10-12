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
});
