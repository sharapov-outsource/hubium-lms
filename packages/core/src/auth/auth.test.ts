import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capturedJobs, useTestDb } from '../../test/helpers.ts';
import { withClientIp } from '../client-ip.ts';
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

  it('knows the client address behind a CDN: sessions and rate limits use it', async () => {
    // a CDN and Caddy in front: X-Forwarded-For holds the client, the CDN and Caddy's peer,
    // and proxy.ts works out the client from TRUSTED_PROXY_HOPS
    const via = (client: string) => {
      const forwarded = new Headers({ 'x-forwarded-for': `6.6.6.6, ${client}, 198.51.100.4` });
      return withClientIp(forwarded, { TRUSTED_PROXY_HOPS: '2' });
    };
    const signIn = await auth.api.signInEmail({
      body: { email: 'student1@hubium.local', password: 'Demo12345!' },
      headers: via('203.0.113.7'),
    });
    const session = await t.db.session.findFirstOrThrow({ where: { token: signIn.token } });
    expect(session.ipAddress).toBe('203.0.113.7');

    process.env.AUTH_RATE_LIMIT = 'on';
    const limited = createAuth({ db: t.db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
    delete process.env.AUTH_RATE_LIMIT;
    const attempt = (client: string) => {
      const headers = via(client);
      headers.set('content-type', 'application/json');
      headers.set('origin', 'http://lms.test');
      return limited.handler(
        new Request('http://lms.test/api/auth/sign-in/email', {
          method: 'POST',
          headers,
          body: JSON.stringify({ email: 'nobody@example.org', password: 'Wrong12345!' }),
        }),
      );
    };
    // three sign-ins in ten seconds from one address, as Better Auth allows
    for (let i = 0; i < 3; i++) expect((await attempt('203.0.113.20')).status).toBe(401);
    expect((await attempt('203.0.113.20')).status).toBe(429);
    // someone else at the same school is not held back by them
    expect((await attempt('203.0.113.21')).status).toBe(401);
  });

  it('a person created without an email who adds and confirms one gets letters again', async () => {
    const student = await t.db.user.findFirstOrThrow({ where: { username: 'student3' } });
    await t.db.user.update({
      where: { id: student.id },
      // as an administrator creates someone without an email
      data: { email: `${student.id}@users.invalid`, emailPlaceholder: true },
    });
    const signIn = await auth.api.signInUsername({
      body: { username: 'student3', password: 'Demo12345!' },
      returnHeaders: true,
    });
    const headers = new Headers({
      cookie: signIn.headers
        .getSetCookie()
        .map((l) => l.split(';')[0])
        .join('; '),
    });
    await auth.api.changeEmail({ body: { newEmail: 'ivan@example.org' }, headers });
    const letter = capturedJobs.findLast(
      (j) => j.name === 'email.send' && (j.data as { to: string }).to === 'ivan@example.org',
    );
    const token = /token=([^&\s"]+)/.exec((letter!.data as { text: string }).text)![1]!;
    await auth.api.verifyEmail({ query: { token } });
    const after = await t.db.user.findUniqueOrThrow({ where: { id: student.id } });
    expect([after.email, after.emailVerified, after.emailPlaceholder]).toEqual([
      'ivan@example.org',
      true,
      false,
    ]);
  });

  it('lets people without a password here change two-factor sign-in soon after signing in', async () => {
    const sso = await t.db.user.create({
      data: { email: 'sso-2fa@example.org', name: 'S F', firstName: 'S', lastName: 'F' },
    });
    await t.db.account.create({
      data: { userId: sso.id, providerId: 'keycloak', accountId: 'kc-2fa' },
    });
    const session = await (await auth.$context).internalAdapter.createSession(sso.id);
    const signed = `${session.token}.${createHmac('sha256', 's'.repeat(40)).update(session.token).digest('base64')}`;
    const headers = new Headers({ cookie: `hubium.session_token=${encodeURIComponent(signed)}` });
    // no password to confirm with: a recent sign-in through the provider stands for it
    const on = await auth.api.enableTwoFactor({ body: {}, headers });
    expect(on).toMatchObject({ totpURI: expect.stringMatching(/^otpauth:/) });
    await t.db.session.update({
      where: { token: session.token },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    });
    await expect(auth.api.generateBackupCodes({ body: {}, headers })).rejects.toMatchObject({
      body: { code: 'SESSION_NOT_FRESH' },
    });
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
