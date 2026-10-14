import { type SSOOptions, sso } from '@better-auth/sso';
import type { Db, Prisma, SsoProvider } from '@hubium/db';
import { log } from '@hubium/log';
import { safeFetch, ssrfAllowedHosts, UnsafeUrlError } from '@hubium/module-sdk/net';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { decryptSecret, encryptSecret } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { defineOperation } from '../operation.ts';
import {
  listProfileFields,
  type ProfileValues,
  validateProfileValues,
  writeProfileValues,
} from '../users/profile-fields.ts';
import { generateSpKeyPair, spMetadataXml } from './saml-keys.ts';

const logger = log('sso');

// Single sign-on through OIDC or SAML 2.0, on Better Auth's SSO plugin. Administrators
// manage providers here (the plugin's own registration endpoints are closed in auth.ts).
// Hubium decides who may sign in: an existing account with the same email is used when
// the provider allows it, and new accounts are created only when it says so. Names and
// mapped profile fields are refreshed from the provider at every sign-in.

export const SSO_PROTOCOLS = ['oidc', 'saml'] as const;
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number];

/** Extra fields carry profile fields under this prefix through Better Auth's mapping. */
const FIELD_PREFIX = 'hubium_field_';

const seal = (s: string) => encryptSecret(s, getEnv().APP_SECRET);
const unseal = (s: string) => decryptSecret(s, getEnv().APP_SECRET);

const attr = z.string().trim().max(200);
export const SsoMapping = z.object({
  email: attr.optional(),
  firstName: attr.optional(),
  lastName: attr.optional(),
  /** Profile field short name → claim or attribute name. */
  fields: z.record(z.string(), attr).default({}),
});
export type SsoMapping = z.output<typeof SsoMapping>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || undefined);

export const SsoProviderInput = z.object({
  id: z.string().uuid().optional(),
  providerId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'Latin letters, digits and dashes, 2–49 characters'),
  name: z.string().trim().min(1).max(100),
  protocol: z.enum(SSO_PROTOCOLS),
  enabled: z.boolean().default(true),
  autoCreate: z.boolean().default(false),
  linkByEmail: z.boolean().default(true),
  domain: z.string().trim().max(500).default(''),
  // OIDC
  issuer: optionalText(500),
  clientId: optionalText(500),
  /** Empty keeps the stored secret. */
  clientSecret: optionalText(2000),
  scopes: optionalText(500),
  // SAML: identity provider metadata, from a URL or pasted
  idpMetadataUrl: optionalText(1000),
  idpMetadataXml: optionalText(500_000),
  mapping: SsoMapping.default({ fields: {} }),
});
export type SsoProviderInput = z.input<typeof SsoProviderInput>;

/** SAML entity ID of Hubium for a provider: its metadata URL, as most IdPs expect. */
export function spEntityId(appUrl: string, providerId: string): string {
  return `${appUrl}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
}

export function ssoCallbackUrls(appUrl: string, providerId: string) {
  return {
    oidcRedirect: `${appUrl}/api/auth/sso/callback/${providerId}`,
    samlAcs: `${appUrl}/api/auth/sso/saml2/sp/acs/${providerId}`,
    samlMetadata: spEntityId(appUrl, providerId),
  };
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

async function fetchText(url: string, field: string): Promise<string> {
  try {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    const why = e instanceof UnsafeUrlError ? e.message : `Cannot load ${url}: ${String(e)}`;
    throw new ValidationError({ [field]: [why] });
  }
}

/** Reads the provider's discovery document (checked against SSRF on every hop). */
export async function discoverOidc(issuer: string): Promise<Discovery & { url: string }> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let doc: Partial<Discovery>;
  try {
    doc = JSON.parse(await fetchText(url, 'issuer')) as Partial<Discovery>;
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError({ issuer: ['The discovery document is not JSON'] });
  }
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri)
    throw new ValidationError({ issuer: ['The discovery document lacks required endpoints'] });
  return { ...(doc as Discovery), url };
}

/** The IdP's entity ID and its HTTP-Redirect (else POST) sign-on URL from SAML metadata. */
export function parseIdpMetadata(xml: string): { entityId: string; ssoUrl: string } {
  const entityId = /<(?:\w+:)?EntityDescriptor\b[^>]*\bentityID="([^"]+)"/.exec(xml)?.[1];
  const services = [...xml.matchAll(/<(?:\w+:)?SingleSignOnService\b[^>]*>/g)].map((m) => m[0]);
  const loc = (s: string | undefined) => (s ? /\bLocation="([^"]+)"/.exec(s)?.[1] : undefined);
  const ssoUrl =
    loc(services.find((s) => s.includes('HTTP-Redirect'))) ??
    loc(services.find((s) => s.includes('HTTP-POST')));
  if (!entityId || !ssoUrl)
    throw new ValidationError({
      idpMetadataXml: ['The metadata has no entity ID or single sign-on service'],
    });
  return { entityId, ssoUrl };
}

function extraFields(m: SsoMapping, first: string, last: string): Record<string, string> {
  return {
    firstName: m.firstName || first,
    lastName: m.lastName || last,
    ...Object.fromEntries(
      Object.entries(m.fields)
        .filter(([, a]) => a)
        .map(([short, a]) => [FIELD_PREFIX + short, a]),
    ),
  };
}

/** The provider row Better Auth reads, from what the administrator entered. */
async function buildProvider(
  input: z.output<typeof SsoProviderInput>,
  appUrl: string,
  existing: SsoProvider | null,
) {
  const same = existing?.protocol === input.protocol ? existing : null;
  if (input.protocol === 'oidc') {
    const storedSecret = same?.clientSecretEnc ?? null;
    const errors: Record<string, string[]> = {};
    if (!input.issuer) errors.issuer = ['Required'];
    if (!input.clientId) errors.clientId = ['Required'];
    if (!input.clientSecret && !storedSecret) errors.clientSecret = ['Required'];
    if (Object.keys(errors).length) throw new ValidationError(errors);
    const d = await discoverOidc(input.issuer!);
    const methods = d.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    const oidcConfig = {
      issuer: d.issuer,
      pkce: true,
      clientId: input.clientId!,
      discoveryEndpoint: d.url,
      authorizationEndpoint: d.authorization_endpoint,
      tokenEndpoint: d.token_endpoint,
      jwksEndpoint: d.jwks_uri,
      userInfoEndpoint: d.userinfo_endpoint,
      tokenEndpointAuthentication: methods.includes('client_secret_basic')
        ? 'client_secret_basic'
        : 'client_secret_post',
      scopes: (input.scopes ?? 'openid email profile').split(/[\s,]+/).filter(Boolean),
      mapping: {
        email: input.mapping.email || 'email',
        name: 'name',
        extraFields: extraFields(input.mapping, 'given_name', 'family_name'),
      },
    };
    return {
      issuer: d.issuer,
      oidcConfig: JSON.stringify(oidcConfig),
      samlConfig: null,
      clientSecretEnc: input.clientSecret ? seal(input.clientSecret) : storedSecret,
      spPrivateKeyEnc: null,
      spCertificate: null,
    };
  }
  // without new metadata an edit keeps the identity provider's
  const stored = same?.samlConfig
    ? (JSON.parse(same.samlConfig) as { idpMetadata?: { metadata?: string } })
    : null;
  const xml = input.idpMetadataUrl
    ? await fetchText(input.idpMetadataUrl, 'idpMetadataUrl')
    : (input.idpMetadataXml ?? stored?.idpMetadata?.metadata);
  if (!xml) throw new ValidationError({ idpMetadataUrl: ['Give a metadata URL or paste the XML'] });
  const idp = parseIdpMetadata(xml);
  // one signing key per provider, kept across edits
  const keys =
    same?.spPrivateKeyEnc && same.spCertificate
      ? { sealed: same.spPrivateKeyEnc, certificate: same.spCertificate }
      : (() => {
          const k = generateSpKeyPair(`Hubium LMS ${input.providerId}`);
          return { sealed: seal(k.privateKey), certificate: k.certificate };
        })();
  const entityId = spEntityId(appUrl, input.providerId);
  const samlConfig = {
    issuer: entityId,
    entryPoint: idp.ssoUrl,
    idpMetadata: { metadata: xml },
    // the private key is added on read (withSsoSecrets)
    spMetadata: {
      metadata: spMetadataXml({
        entityId,
        acsUrl: ssoCallbackUrls(appUrl, input.providerId).samlAcs,
        certificate: keys.certificate,
      }),
    },
    authnRequestsSigned: true,
    wantAssertionsSigned: true,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    mapping: {
      ...(input.mapping.email ? { email: input.mapping.email } : {}),
      extraFields: extraFields(input.mapping, 'firstName', 'lastName'),
    },
  };
  return {
    issuer: idp.entityId,
    oidcConfig: null,
    samlConfig: JSON.stringify(samlConfig),
    clientSecretEnc: null,
    spPrivateKeyEnc: keys.sealed,
    spCertificate: keys.certificate,
  };
}

// ── administration ──────────────────────────────────────────────────────────

export async function listSsoProviders(ctx: RequestContext) {
  await ctx.perm.require('site:config');
  const rows = await ctx.db.ssoProvider.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map(({ clientSecretEnc, spPrivateKeyEnc, ...p }) => ({
    ...p,
    hasSecret: !!clientSecretEnc,
  }));
}

/** Providers on the sign-in page. */
export async function enabledSsoProviders(db: Db) {
  return db.ssoProvider.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { providerId: true, name: true },
  });
}

export const saveSsoProvider = defineOperation({
  name: 'auth.saveSsoProvider',
  input: SsoProviderInput,
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, input) {
    const existing = input.id
      ? await ctx.tx.ssoProvider.findUnique({ where: { id: input.id } })
      : null;
    if (input.id && !existing) throw new NotFoundError('Provider');
    const clash = await ctx.tx.ssoProvider.findUnique({ where: { providerId: input.providerId } });
    if (clash && clash.id !== existing?.id)
      throw new ValidationError({ providerId: ['This identifier is already used'] });
    // the provider's id is in its callback URLs and linked accounts: it cannot change
    if (existing && existing.providerId !== input.providerId)
      throw new ValidationError({ providerId: ['The identifier cannot be changed'] });
    const fields = new Set((await listProfileFields(ctx.tx)).map((f) => f.shortName));
    const unknown = Object.keys(input.mapping.fields).filter((f) => !fields.has(f));
    if (unknown.length)
      throw new ValidationError({ mapping: [`Unknown profile fields: ${unknown.join(', ')}`] });
    const built = await buildProvider(input, getEnv().APP_URL, existing);
    const data = {
      providerId: input.providerId,
      name: input.name,
      protocol: input.protocol,
      enabled: input.enabled,
      autoCreate: input.autoCreate,
      linkByEmail: input.linkByEmail,
      domain: input.domain,
      mapping: input.mapping as Prisma.InputJsonValue,
      ...built,
    };
    const row = existing
      ? await ctx.tx.ssoProvider.update({ where: { id: existing.id }, data })
      : await ctx.tx.ssoProvider.create({ data: { ...data, userId: ctx.perm.userId! } });
    await logEvent(ctx.tx, {
      name: existing ? 'auth.ssoProviderUpdated' : 'auth.ssoProviderCreated',
      actorId: ctx.perm.userId,
      objectType: 'ssoProvider',
      objectId: row.id,
      data: { providerId: row.providerId, protocol: row.protocol },
      origin: ctx.origin,
    });
    return { id: row.id };
  },
});

export const deleteSsoProvider = defineOperation({
  name: 'auth.deleteSsoProvider',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, { id }) {
    const p = await ctx.tx.ssoProvider.findUnique({ where: { id } });
    if (!p) throw new NotFoundError('Provider');
    await ctx.tx.ssoProvider.delete({ where: { id } });
    // people keep their Hubium accounts; only the link to this provider goes
    await ctx.tx.account.deleteMany({ where: { providerId: p.providerId } });
    await logEvent(ctx.tx, {
      name: 'auth.ssoProviderDeleted',
      actorId: ctx.perm.userId,
      objectType: 'ssoProvider',
      objectId: id,
      data: { providerId: p.providerId },
      origin: ctx.origin,
    });
    return { id };
  },
});

// ── Better Auth ─────────────────────────────────────────────────────────────

/**
 * The client Better Auth's adapter uses: SSO rows come back with the client secret
 * unsealed into oidcConfig, so the secret is encrypted at rest but usable by the plugin.
 */
export function withSsoSecrets(db: Db) {
  return db.$extends({
    result: {
      ssoProvider: {
        oidcConfig: {
          needs: { oidcConfig: true, clientSecretEnc: true },
          compute(p) {
            if (!p.oidcConfig || !p.clientSecretEnc) return p.oidcConfig;
            try {
              return JSON.stringify({
                ...JSON.parse(p.oidcConfig),
                clientSecret: unseal(p.clientSecretEnc),
              });
            } catch (err) {
              logger.error({ err }, 'cannot unseal an SSO client secret');
              return p.oidcConfig;
            }
          },
        },
        samlConfig: {
          needs: { samlConfig: true, spPrivateKeyEnc: true },
          compute(p) {
            if (!p.samlConfig || !p.spPrivateKeyEnc) return p.samlConfig;
            try {
              const c = JSON.parse(p.samlConfig) as { spMetadata?: object };
              const privateKey = unseal(p.spPrivateKeyEnc);
              return JSON.stringify({
                ...c,
                privateKey,
                spMetadata: { ...c.spMetadata, privateKey },
              });
            } catch (err) {
              logger.error({ err }, 'cannot unseal an SSO signing key');
              return p.samlConfig;
            }
          },
        },
      },
    },
  });
}

type Resolve = NonNullable<SSOOptions['resolveUser']>;
type Provision = NonNullable<SSOOptions['provisionUser']>;

/** Who signs in: an already linked account, an account with the same email, or a new one. */
export function resolveSsoUser(db: Db): Resolve {
  return async (input) => {
    const reject = (code: string) => ({ action: 'reject' as const, code });
    const provider = await db.ssoProvider.findUnique({ where: { providerId: input.providerId } });
    if (!provider?.enabled) return reject('SSO_DISABLED');
    const linked = await db.account.findFirst({
      where: { providerId: input.providerId, accountId: input.accountKey.accountId },
      select: { id: true },
    });
    if (linked) return { action: 'continue' };
    const email = input.providerUser.email?.trim().toLowerCase();
    const user = email
      ? await db.user.findUnique({ where: { email }, select: { id: true, deletedAt: true } })
      : null;
    if (user && !user.deletedAt)
      return provider.linkByEmail
        ? { action: 'link', userId: user.id, profile: 'preserve' }
        : reject('SSO_ACCOUNT_NOT_LINKED');
    return provider.autoCreate ? { action: 'continue' } : reject('SSO_NO_ACCOUNT');
  };
}

/** Refreshes names and mapped profile fields from the provider at every sign-in. */
export function provisionSsoUser(db: Db): Provision {
  return async ({ user, userInfo }) => {
    try {
      const str = (k: string) => {
        const v = (userInfo as Record<string, unknown>)[k];
        const s = Array.isArray(v) ? v[0] : v;
        return typeof s === 'string' ? s.trim() : '';
      };
      const first = str('firstName');
      const last = str('lastName');
      const current = await db.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { firstName: true, lastName: true, emailVerified: true, emailPlaceholder: true },
      });
      const firstName = first || current.firstName;
      const lastName = last || current.lastName;
      await db.user.update({
        where: { id: user.id },
        data: {
          firstName,
          lastName,
          name: `${firstName} ${lastName}`.trim(),
          // the administrator chose to trust this provider's addresses
          ...(current.emailPlaceholder ? {} : { emailVerified: true }),
        },
      });
      const fields = await listProfileFields(db);
      const raw: Record<string, unknown> = {};
      for (const f of fields) {
        const v = str(FIELD_PREFIX + f.shortName);
        if (v) raw[f.shortName] = v;
      }
      let values: ProfileValues = {};
      try {
        values = validateProfileValues(fields, raw);
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'SSO profile values rejected');
      }
      await writeProfileValues(db, user.id, values);
    } catch (err) {
      logger.error({ err, userId: user.id }, 'SSO profile update failed');
    }
  };
}

export function ssoPlugin(db: Db) {
  return sso({
    resolveUser: resolveSsoUser(db),
    provisionUser: provisionSsoUser(db),
    provisionUserOnEveryLogin: true,
    // providers come from Administration → Sign-in, never from users
    providersLimit: 0,
    organizationProvisioning: { disabled: true },
  });
}

/**
 * Origins of SSO providers on internal hosts that SSRF_ALLOW_HOSTS allows. Better Auth
 * refuses private IdP addresses unless they are trusted origins; this keeps its rule in
 * line with Hubium's. Read on each auth request: the table is tiny, and a cache would
 * miss changes made by other processes.
 */
export async function ssoTrustedOrigins(db: Db): Promise<string[]> {
  const allowed = ssrfAllowedHosts();
  const origins = new Set<string>();
  if (allowed.size) {
    for (const p of await db.ssoProvider.findMany({
      select: { oidcConfig: true, samlConfig: true },
    })) {
      const c = JSON.parse(p.oidcConfig ?? p.samlConfig ?? '{}') as Record<string, unknown>;
      for (const v of Object.values(c)) {
        if (typeof v !== 'string' || !/^https?:\/\//.test(v)) continue;
        const u = new URL(v);
        if (allowed.has(u.hostname.replace(/^\[|\]$/g, '').toLowerCase())) origins.add(u.origin);
      }
    }
  }
  return [...origins];
}

/** Better Auth endpoints of the SSO plugin that stay open; the rest is managed here. */
export function isOpenSsoPath(path: string): boolean {
  return path.startsWith('/sso/callback') || path.startsWith('/sso/saml2/');
}
