import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { publishInvalidation } from '../cache-bus.ts';
import { encryptSecret } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { createAuthHolder } from './holder.ts';

describe('auth holder', () => {
  const t = useTestDb();

  it('rebuilds Better Auth with the custom OAuth providers', async () => {
    const holder = createAuthHolder({
      db: t.db,
      baseURL: 'http://lms.test',
      secret: 's'.repeat(40),
    });
    await holder.ready;
    // custom providers sign in through the social endpoint, like built-in ones
    const signIn = () =>
      holder.current().api.signInSocial({
        body: { provider: 'gitlab' as 'google', callbackURL: '/dashboard' },
      });
    await expect(signIn()).rejects.toMatchObject({});

    const admin = await ctxFor(t.db, 'admin@test.local');
    await t.db.ssoProvider.create({
      data: {
        providerId: 'gitlab',
        name: 'GitLab',
        protocol: 'oauth2',
        issuer: 'https://gitlab.example.org',
        userId: admin.perm.userId!,
        clientSecretEnc: encryptSecret('top-secret', getEnv().APP_SECRET),
        oauthConfig: JSON.stringify({
          clientId: 'id',
          authorizationUrl: 'https://gitlab.example.org/oauth/authorize',
          tokenUrl: 'https://gitlab.example.org/oauth/token',
          userInfoUrl: 'https://gitlab.example.org/oauth/userinfo',
          scopes: ['read_user'],
          mapping: { email: 'email', firstName: 'given_name', lastName: 'family_name' },
        }),
      },
    });
    await publishInvalidation(t.db, 'auth');
    await expect
      .poll(async () => (await signIn().catch(() => null))?.url ?? '')
      .toContain('https://gitlab.example.org/oauth/authorize');
  });
});
