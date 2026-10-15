import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ValidationError } from '../errors.ts';
import { parseIdpMetadata, resolveSsoUser, ssoTrustedOrigins } from './sso.ts';

const METADATA = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.org/realms/main">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.org/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.org/redirect"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe('SAML metadata', () => {
  it('gives the entity ID and the redirect sign-on URL', () => {
    expect(parseIdpMetadata(METADATA)).toEqual({
      entityId: 'https://idp.example.org/realms/main',
      ssoUrl: 'https://idp.example.org/redirect',
    });
    expect(() => parseIdpMetadata('<x/>')).toThrow(ValidationError);
  });
});

describe('SSO providers', () => {
  const t = useTestDb();
  const allow = process.env.SSRF_ALLOW_HOSTS;
  let adminId: string;
  let kiraId: string;

  beforeAll(async () => {
    process.env.SSRF_ALLOW_HOSTS = 'idp.internal';
    adminId = (await ctxFor(t.db, 'admin@test.local')).perm.userId!;
    kiraId = (
      await t.db.user.create({
        data: { email: 'kira@school.test', name: 'Кира К', firstName: 'Кира', lastName: 'К' },
      })
    ).id;
    const base = { userId: adminId, protocol: 'oidc', issuer: 'x' };
    await t.db.ssoProvider.createMany({
      data: [
        {
          ...base,
          providerId: 'inside',
          name: 'Inside',
          autoCreate: false,
          linkByEmail: true,
          oidcConfig: JSON.stringify({
            tokenEndpoint: 'http://idp.internal:8080/token',
            jwksEndpoint: 'http://idp.internal:8080/jwks',
            scopes: ['openid'],
          }),
        },
        {
          ...base,
          providerId: 'outside',
          name: 'Outside',
          autoCreate: true,
          linkByEmail: false,
          oidcConfig: JSON.stringify({ tokenEndpoint: 'https://idp.example.org/token' }),
        },
        { ...base, providerId: 'off', name: 'Off', enabled: false },
        {
          ...base,
          providerId: 'other-school',
          name: 'Other school',
          linkByEmail: true,
          domain: 'other.test, partner.test',
        },
      ],
    });
  });
  afterAll(() => {
    process.env.SSRF_ALLOW_HOSTS = allow;
  });

  it('trusts only provider origins that SSRF_ALLOW_HOSTS allows', async () => {
    expect(await ssoTrustedOrigins(t.db)).toEqual(['http://idp.internal:8080']);
  });

  it('links by email, creates or refuses as the provider says', async () => {
    const resolve = resolveSsoUser(t.db);
    const input = (
      providerId: string,
      email: string,
      claims: Record<string, unknown> = { email_verified: true },
      protocol = 'oidc',
    ) =>
      ({
        protocol,
        providerId,
        accountKey: { issuer: 'x', accountId: `sub-${email}` },
        providerUser: { email, emailVerified: false, name: 'N' },
        providerReference: {},
        providerClaims: {},
        verifiedIdTokenClaims: claims,
        providerAttributes: {},
      }) as never;
    const ctx = { database: {} } as never;
    expect(await resolve(input('inside', 'KIRA@school.test'), ctx)).toEqual({
      action: 'link',
      userId: kiraId,
      profile: 'preserve',
    });
    // an address the provider does not vouch for could be anyone's
    for (const claims of [{}, { email_verified: false }])
      expect(await resolve(input('inside', 'kira@school.test', claims), ctx)).toMatchObject({
        code: 'SSO_ACCOUNT_NOT_LINKED',
      });
    // a SAML assertion has no such claim: the identity provider answers for it
    expect(await resolve(input('inside', 'kira@school.test', {}, 'saml'), ctx)).toMatchObject({
      action: 'link',
    });
    // only the provider's own domains, and never an administrator
    expect(await resolve(input('other-school', 'kira@school.test'), ctx)).toMatchObject({
      code: 'SSO_ACCOUNT_NOT_LINKED',
    });
    expect(await resolve(input('inside', 'admin@test.local'), ctx)).toMatchObject({
      code: 'SSO_ACCOUNT_NOT_LINKED',
    });
    expect(await resolve(input('inside', 'new@example.org'), ctx)).toMatchObject({
      action: 'reject',
      code: 'SSO_NO_ACCOUNT',
    });
    expect(await resolve(input('outside', 'new@example.org'), ctx)).toEqual({
      action: 'continue',
    });
    expect(await resolve(input('outside', 'admin@test.local'), ctx)).toMatchObject({
      code: 'SSO_ACCOUNT_NOT_LINKED',
    });
    expect(await resolve(input('off', 'admin@test.local'), ctx)).toMatchObject({
      code: 'SSO_DISABLED',
    });
    // an account already linked to this provider signs in as itself
    await t.db.account.create({
      data: { userId: adminId, providerId: 'outside', accountId: 'sub-admin@test.local' },
    });
    expect(await resolve(input('outside', 'admin@test.local'), ctx)).toEqual({
      action: 'continue',
    });
  });
});
