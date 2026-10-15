import { createHmac } from 'node:crypto';
import type { Db, LdapServer, Prisma } from '@hubium/db';
import { log } from '@hubium/log';
import { msg } from '@hubium/module-sdk';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { expireCookie, setSessionCookie } from 'better-auth/cookies';
import { generateRandomString } from 'better-auth/crypto';
import { Client, InvalidCredentialsError } from 'ldapts';
import { z } from 'zod';
import { clientIp } from '../client-ip.ts';
import type { RequestContext } from '../context.ts';
import { decryptSecret, encryptSecret } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { defineOperation } from '../operation.ts';
import {
  listProfileFields,
  type ProfileValues,
  validateProfileValues,
  writeProfileValues,
} from '../users/profile-fields.ts';
import { placeholderEmail, USERNAME_RE } from '../users/users.ts';
import { isLocked, recordFailedSignIn } from './lockout.ts';

const logger = log('ldap');

// Sign-in through an LDAP directory (OpenLDAP, Active Directory, FreeIPA…), as Moodle's
// auth_ldap: the service account finds the person's entry, a bind with their password
// checks it. Accounts are linked by the directory's stable id; an existing account with the
// same email or username is used when allowed, and new ones are created only when allowed.
// Names, email and mapped profile fields follow the directory at every sign-in and in the
// nightly sync, which can also suspend people the directory no longer has.

export const LDAP_PROVIDER = 'ldap';
export const LDAP_SYNC_JOB = 'auth.ldapSync';

const seal = (s: string) => encryptSecret(s, getEnv().APP_SECRET);
const unseal = (s: string) => decryptSecret(s, getEnv().APP_SECRET);

/** RFC 4515: a value inside a search filter. */
export function escapeFilterValue(s: string): string {
  return s.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

const attr = z.string().trim().max(200);
export const LdapMapping = z.object({
  email: attr.default('mail'),
  firstName: attr.default('givenName'),
  lastName: attr.default('sn'),
  fields: z.record(z.string(), attr).default({}),
});
export type LdapMapping = z.output<typeof LdapMapping>;

export const LdapInput = z.object({
  enabled: z.boolean(),
  url: z
    .string()
    .trim()
    .regex(/^ldaps?:\/\/[^/\s]+\/?$/i, 'ldap://host:389 or ldaps://host:636'),
  startTls: z.boolean().default(false),
  caCertificate: z
    .string()
    .trim()
    .max(20_000)
    .optional()
    .transform((v) => v || null),
  bindDn: z.string().trim().max(500).default(''),
  /** Empty keeps the stored password. */
  bindPassword: z.string().max(500).optional(),
  baseDn: z.string().trim().min(1).max(500),
  userFilter: z
    .string()
    .trim()
    .max(1000)
    .refine((f) => f.includes('{login}'), 'The filter must contain {login}'),
  loginAttribute: z.string().trim().min(1).max(100),
  idAttribute: z.string().trim().max(100).default(''),
  mapping: LdapMapping,
  autoCreate: z.boolean().default(false),
  linkByEmail: z.boolean().default(false),
  suspendMissing: z.boolean().default(false),
});

export async function getLdapServer(db: Db | Prisma.TransactionClient) {
  return db.ldapServer.findUnique({ where: { id: 'default' } });
}

export async function ldapEnabled(db: Db): Promise<boolean> {
  return !!(await db.ldapServer.findFirst({ where: { enabled: true }, select: { id: true } }));
}

// ── directory access ───────────────────────────────────────────────────────

async function connect(s: LdapServer): Promise<Client> {
  const tlsOptions = s.caCertificate ? { ca: [s.caCertificate] } : undefined;
  const client = new Client({ url: s.url, timeout: 10_000, connectTimeout: 5_000, tlsOptions });
  if (s.startTls) await client.startTLS(tlsOptions);
  return client;
}

async function serviceBind(s: LdapServer, client: Client) {
  if (s.bindDn) await client.bind(s.bindDn, s.bindPasswordEnc ? unseal(s.bindPasswordEnc) : '');
}

type Entry = Record<string, unknown> & { dn: string };

function first(entry: Entry, name: string): string {
  if (!name) return '';
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key ? entry[key] : undefined;
  const one = Array.isArray(v) ? v[0] : v;
  if (Buffer.isBuffer(one)) return one.toString('hex');
  return typeof one === 'string' ? one.trim() : '';
}

function attributesOf(s: LdapServer): string[] {
  const m = LdapMapping.parse(s.mapping ?? {});
  return [
    ...new Set(
      [
        s.loginAttribute,
        s.idAttribute,
        m.email,
        m.firstName,
        m.lastName,
        ...Object.values(m.fields),
      ].filter(Boolean),
    ),
  ];
}

async function findEntries(s: LdapServer, client: Client, login: string): Promise<Entry[]> {
  const filter = s.userFilter.replaceAll('{login}', escapeFilterValue(login));
  const r = await client.search(s.baseDn, {
    scope: 'sub',
    filter,
    attributes: attributesOf(s),
    sizeLimit: 2,
  });
  return r.searchEntries as Entry[];
}

export interface LdapPerson {
  dn: string;
  accountId: string;
  login: string;
  email: string;
  firstName: string;
  lastName: string;
  fields: Record<string, string>;
}

function personOf(s: LdapServer, entry: Entry): LdapPerson {
  const m = LdapMapping.parse(s.mapping ?? {});
  const login = first(entry, s.loginAttribute).toLowerCase();
  return {
    dn: entry.dn,
    accountId: first(entry, s.idAttribute) || login,
    login,
    email: first(entry, m.email).toLowerCase(),
    firstName: first(entry, m.firstName),
    lastName: first(entry, m.lastName),
    fields: Object.fromEntries(
      Object.entries(m.fields).map(([short, a]) => [short, first(entry, a)]),
    ),
  };
}

export type LdapCheck =
  | { status: 'unknown' }
  | { status: 'refused'; person: LdapPerson }
  | { status: 'invalid'; person: LdapPerson }
  | { status: 'ok'; person: LdapPerson };

/**
 * Finds the login in the directory and checks the password with a bind as that entry.
 * `refuse` sees the entry first: when it says so, the password is not tried at all.
 */
export async function checkLdapPassword(
  s: LdapServer,
  login: string,
  password: string,
  refuse?: (person: LdapPerson) => Promise<boolean>,
): Promise<LdapCheck> {
  // an empty password would be an anonymous bind, which succeeds
  if (!login.trim() || !password) return { status: 'unknown' };
  const client = await connect(s);
  try {
    await serviceBind(s, client);
    const entries = await findEntries(s, client, login.trim());
    if (entries.length !== 1) return { status: 'unknown' };
    const person = personOf(s, entries[0]!);
    if (await refuse?.(person)) return { status: 'refused', person };
    try {
      await client.bind(person.dn, password);
      return { status: 'ok', person };
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return { status: 'invalid', person };
      throw e;
    }
  } finally {
    await client.unbind().catch(() => {});
  }
}

// ── Hubium accounts ────────────────────────────────────────────────────────

/** Names, email and mapped profile fields from the directory. */
async function updateFromDirectory(db: Db, userId: string, p: LdapPerson) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true },
  });
  const firstName = p.firstName || user.firstName;
  const lastName = p.lastName || user.lastName;
  const emailFree =
    p.email &&
    p.email !== user.email &&
    !(await db.user.findUnique({ where: { email: p.email }, select: { id: true } }));
  await db.user.update({
    where: { id: userId },
    data: {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim(),
      ...(emailFree ? { email: p.email, emailPlaceholder: false, emailVerified: true } : {}),
    },
  });
  const fields = await listProfileFields(db);
  const raw = Object.fromEntries(Object.entries(p.fields).filter(([, v]) => v));
  let values: ProfileValues = {};
  try {
    values = validateProfileValues(fields, raw);
  } catch (err) {
    logger.warn({ err, userId }, 'directory profile values rejected');
  }
  await writeProfileValues(db, userId, values);
}

export type LdapSignIn =
  | { kind: 'fallback' }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'user'; userId: string };

type AccountMatch = {
  linked: boolean;
  users: { id: string; status: string; lockedUntil: Date | null; isSiteAdmin: boolean }[];
};

/** The account linked to a directory entry, or those with its email or login. */
async function accountsFor(db: Db, p: LdapPerson): Promise<AccountMatch> {
  const select = { id: true, status: true, lockedUntil: true, isSiteAdmin: true } as const;
  const link = await db.account.findFirst({
    where: { providerId: LDAP_PROVIDER, accountId: p.accountId },
    select: { user: { select } },
  });
  if (link) return { linked: true, users: [link.user] };
  const users = await db.user.findMany({
    where: {
      deletedAt: null,
      OR: [...(p.email ? [{ email: p.email }] : []), { username: p.login }],
    },
    select,
    take: 2,
  });
  return { linked: false, users };
}

/**
 * The Hubium account for a directory login, or why there is none. "fallback" means the
 * directory cannot decide (unknown login, or a wrong password for someone who also has a
 * local password): the sign-in form then tries the local password.
 */
export async function signInWithLdap(
  db: Db,
  login: string,
  password: string,
  opts: { appUrl: string; ip?: string | null },
): Promise<LdapSignIn> {
  const s = await getLdapServer(db);
  if (!s?.enabled) return { kind: 'fallback' };
  let match: AccountMatch = { linked: false, users: [] };
  let check: LdapCheck;
  try {
    check = await checkLdapPassword(s, login, password, async (p) => {
      match = await accountsFor(db, p);
      // Hubium's lockout first: a guessed password never reaches the directory, whose own
      // lockout policy would otherwise lock the person out of everything
      return match.users.length === 1 && isLocked(match.users[0]!);
    });
  } catch (err) {
    logger.error({ err }, 'LDAP sign-in failed');
    return { kind: 'fallback' };
  }
  if (check.status === 'unknown') return { kind: 'fallback' };
  if (check.status === 'refused')
    return {
      kind: 'refused',
      code: 'ACCOUNT_LOCKED',
      message: 'This account is locked after failed sign-ins',
    };
  const p = check.person;
  const { linked, users } = match;
  const user = users.length === 1 ? users[0]! : null;

  if (check.status === 'invalid') {
    const local = await db.account.count({
      where: { userId: { in: users.map((u) => u.id) }, providerId: 'credential' },
    });
    if (local) return { kind: 'fallback' };
    if (user) await recordFailedSignIn(db, user.id, opts);
    return { kind: 'refused', code: 'INVALID_LOGIN', message: 'Invalid login or password' };
  }

  // the email belongs to one account and the login to another: neither is taken over
  if (users.length > 1)
    return {
      kind: 'refused',
      code: 'LDAP_ACCOUNT_AMBIGUOUS',
      message: 'The email and the username belong to different accounts',
    };
  if (user && user.status !== 'ACTIVE')
    return { kind: 'refused', code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended' };
  let id = user?.id;
  if (user && !linked) {
    // a directory entry never takes over an administrator's account
    if (!s.linkByEmail || user.isSiteAdmin)
      return {
        kind: 'refused',
        code: 'LDAP_ACCOUNT_NOT_LINKED',
        message: 'An account with this email or username exists',
      };
    await db.account.create({
      data: { userId: user.id, providerId: LDAP_PROVIDER, accountId: p.accountId },
    });
  }
  if (!id) {
    if (!s.autoCreate)
      return { kind: 'refused', code: 'LDAP_NO_ACCOUNT', message: 'No account on this site' };
    id = await db.$transaction(async (tx) => {
      const usernameFree =
        USERNAME_RE.test(p.login) &&
        !(await tx.user.findUnique({ where: { username: p.login }, select: { id: true } }));
      const username = usernameFree ? p.login : null;
      const email = p.email || (username ? placeholderEmail(username) : '');
      if (!email)
        throw new Error(`Directory entry ${p.dn} has neither an email nor a usable login`);
      const created = await tx.user.create({
        data: {
          email,
          emailPlaceholder: !p.email,
          emailVerified: !!p.email,
          username,
          displayUsername: username,
          name: `${p.firstName} ${p.lastName}`.trim() || p.login,
          firstName: p.firstName,
          lastName: p.lastName,
        },
      });
      await tx.account.create({
        data: { userId: created.id, providerId: LDAP_PROVIDER, accountId: p.accountId },
      });
      await logEvent(tx, {
        name: 'user.created',
        relatedUserId: created.id,
        objectType: 'user',
        objectId: created.id,
        data: { source: 'ldap' },
      });
      return created.id;
    });
  }
  await updateFromDirectory(db, id, p);
  return { kind: 'user', userId: id };
}

// ── Better Auth ─────────────────────────────────────────────────────────────

const hmac = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('base64url');

/**
 * POST /sign-in/ldap. Two-factor authentication applies as for a password sign-in: unless
 * the device is trusted, the answer is a two-factor challenge with Better Auth's cookie,
 * which its /two-factor/verify-* endpoints (and recovery phrases) then complete.
 */
export function ldapSignIn(db: Db, appUrl: string) {
  return {
    id: 'hubium-ldap',
    endpoints: {
      signInLdap: createAuthEndpoint(
        '/sign-in/ldap',
        {
          method: 'POST',
          body: z.object({
            login: z.string().max(200),
            password: z.string().max(500),
            rememberMe: z.boolean().optional(),
          }),
        },
        async (ctx) => {
          const ip = clientIp(ctx.request?.headers.get('x-forwarded-for'));
          const r = await signInWithLdap(db, ctx.body.login, ctx.body.password, { appUrl, ip });
          if (r.kind === 'fallback')
            throw new APIError('UNAUTHORIZED', {
              code: 'LDAP_FALLBACK',
              message: 'Not a directory account',
            });
          if (r.kind === 'refused')
            throw new APIError(r.code === 'INVALID_LOGIN' ? 'UNAUTHORIZED' : 'FORBIDDEN', {
              code: r.code,
              message: r.message,
            });
          const user = await ctx.context.internalAdapter.findUserById(r.userId);
          if (!user) throw new APIError('UNAUTHORIZED', { code: 'INVALID_LOGIN' });

          if ((user as { twoFactorEnabled?: boolean }).twoFactorEnabled) {
            const secret = ctx.context.secret;
            const trustCookie = ctx.context.createAuthCookie('trust_device');
            const trusted = await ctx.getSignedCookie(trustCookie.name, secret);
            const [token, trustId] = trusted ? trusted.split('!') : [];
            const record =
              token && trustId && token === hmac(secret, `${user.id}!${trustId}`)
                ? await ctx.context.internalAdapter.findVerificationValue(trustId)
                : null;
            if (!(record && record.value === user.id && record.expiresAt > new Date())) {
              if (trusted) expireCookie(ctx, trustCookie);
              const maxAge = 600;
              const challenge = ctx.context.createAuthCookie('two_factor', { maxAge });
              const identifier = `2fa-${generateRandomString(20)}`;
              const expiresAt = new Date(Date.now() + maxAge * 1000);
              await ctx.context.internalAdapter.createVerificationValue({
                value: user.id,
                identifier,
                expiresAt,
              });
              await ctx.context.internalAdapter.createVerificationValue({
                value: '0',
                identifier: `2fa-attempts-${identifier}`,
                expiresAt,
              });
              await ctx.setSignedCookie(challenge.name, identifier, secret, challenge.attributes);
              return ctx.json({ twoFactorRedirect: true });
            }
          }
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            ctx.body.rememberMe === false,
          );
          if (!session)
            throw new APIError('FORBIDDEN', {
              code: 'ACCOUNT_SUSPENDED',
              message: 'This account is suspended',
            });
          await setSessionCookie(ctx, { session, user }, ctx.body.rememberMe === false);
          return ctx.json({ token: session.token });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

// ── administration ──────────────────────────────────────────────────────────

export const saveLdapServer = defineOperation({
  name: 'auth.saveLdapServer',
  input: LdapInput,
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, input) {
    const existing = await getLdapServer(ctx.tx);
    const fields = new Set((await listProfileFields(ctx.tx)).map((f) => f.shortName));
    const unknown = Object.keys(input.mapping.fields).filter((f) => !fields.has(f));
    if (unknown.length)
      throw new ValidationError({
        mapping: [msg('errors.auth.unknownProfileFields', { unknown: unknown.join(', ') })],
      });
    const { bindPassword, ...rest } = input;
    const data = {
      ...rest,
      mapping: input.mapping as Prisma.InputJsonValue,
      bindPasswordEnc: bindPassword ? seal(bindPassword) : (existing?.bindPasswordEnc ?? null),
    };
    await ctx.tx.ldapServer.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...data },
      update: data,
    });
    await logEvent(ctx.tx, {
      name: 'auth.ldapUpdated',
      actorId: ctx.perm.userId,
      objectType: 'ldapServer',
      objectId: 'default',
      data: { enabled: input.enabled, url: input.url },
      origin: ctx.origin,
    });
    return { ok: true };
  },
});

/** Administration: connect, bind as the service account and look up one login. */
export async function testLdapConnection(ctx: RequestContext, login: string) {
  await ctx.perm.require('site:config');
  const s = await getLdapServer(ctx.db);
  if (!s) throw new ValidationError({ url: [msg('errors.auth.saveSettingsFirst')] });
  let client: Client | undefined;
  try {
    client = await connect(s);
    await serviceBind(s, client);
    if (!login.trim()) return { ok: true as const, person: null };
    const entries = await findEntries(s, client, login.trim());
    return {
      ok: true as const,
      person: entries.length === 1 ? personOf(s, entries[0]!) : null,
      matches: entries.length,
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client?.unbind().catch(() => {});
  }
}

// ── nightly sync ───────────────────────────────────────────────────────────

/**
 * Brings directory accounts up to date; with suspendMissing, suspends the ones the
 * directory no longer has (and reactivates ones that came back, if the sync suspended them).
 */
export async function syncLdapUsers(db: Db) {
  const s = await getLdapServer(db);
  if (!s?.enabled) return { skipped: 'LDAP is off' };
  const accounts = await db.account.findMany({
    where: { providerId: LDAP_PROVIDER, user: { deletedAt: null } },
    select: { userId: true, accountId: true, user: { select: { username: true, status: true } } },
  });
  const result = { checked: 0, updated: 0, suspended: 0, reactivated: 0, errors: 0 };
  const client = await connect(s);
  try {
    await serviceBind(s, client);
    for (const a of accounts) {
      result.checked++;
      try {
        // by the stable id, else by the login when it is the same person
        const byId = s.idAttribute
          ? ((
              await client.search(s.baseDn, {
                scope: 'sub',
                filter: `(${s.idAttribute}=${escapeFilterValue(a.accountId)})`,
                attributes: attributesOf(s),
                sizeLimit: 2,
              })
            ).searchEntries as Entry[])
          : [];
        const entries = byId.length
          ? byId
          : (await findEntries(s, client, a.user.username ?? a.accountId)).filter(
              (e) => personOf(s, e).accountId === a.accountId,
            );
        if (entries.length === 1) {
          await updateFromDirectory(db, a.userId, personOf(s, entries[0]!));
          result.updated++;
          const suspendedBySync = await db.eventLog.findFirst({
            where: { name: 'user.suspended', relatedUserId: a.userId },
            orderBy: { createdAt: 'desc' },
            select: { data: true },
          });
          if (
            a.user.status === 'SUSPENDED' &&
            (suspendedBySync?.data as { source?: string } | null)?.source === 'ldap'
          ) {
            await db.user.update({ where: { id: a.userId }, data: { status: 'ACTIVE' } });
            await logEvent(db, {
              name: 'user.unsuspended',
              relatedUserId: a.userId,
              data: { source: 'ldap' },
              origin: 'WORKER',
            });
            result.reactivated++;
          }
        } else if (entries.length === 0 && s.suspendMissing && a.user.status === 'ACTIVE') {
          await db.user.update({ where: { id: a.userId }, data: { status: 'SUSPENDED' } });
          await db.session.deleteMany({ where: { userId: a.userId } });
          await logEvent(db, {
            name: 'user.suspended',
            relatedUserId: a.userId,
            data: { source: 'ldap' },
            origin: 'WORKER',
          });
          result.suspended++;
        }
      } catch (err) {
        result.errors++;
        logger.warn({ err, userId: a.userId }, 'LDAP sync of one account failed');
      }
    }
  } finally {
    await client.unbind().catch(() => {});
  }
  await db.ldapServer.update({
    where: { id: 'default' },
    data: { lastSyncAt: new Date(), lastSyncResult: result },
  });
  return result;
}
