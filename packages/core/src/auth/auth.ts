import { type Db, uuidv7 } from '@hubium/db';
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { admin, twoFactor, username } from 'better-auth/plugins';
import {
  type GenericOAuthConfig,
  genericOAuth,
  keycloak,
  yandex,
} from 'better-auth/plugins/generic-oauth';
import { CLIENT_IP_HEADER, clientIp } from '../client-ip.ts';
import { ValidationError } from '../errors.ts';
import { sendAuthEmail } from '../mail/mail.ts';
import { getAllSettings, userLocale } from '../settings/settings.ts';
import { noteSignIn } from './devices.ts';
import { ldapSignIn } from './ldap.ts';
import { clearFailedSignIns, findSignInUser, isLocked, recordFailedSignIn } from './lockout.ts';
import { impersonatedBy, loginAs } from './login-as.ts';
import {
  assertPasswordAllowed,
  passwordExpired,
  passwordPolicy,
  recordPasswordChange,
} from './password-policy.ts';
import { dropRecoveryPassphrases, recoveryPassphrase } from './recovery.ts';
import {
  type CustomOAuthProvider,
  isOpenSsoPath,
  ssoPlugin,
  ssoTrustedOrigins,
  withSsoSecrets,
} from './sso.ts';

// Better Auth instance. Authentication only — authorization is Hubium's own (can()).

export interface CreateAuthOptions {
  db: Db;
  baseURL: string;
  secret: string;
  /** Framework plugins (e.g. nextCookies) appended last. */
  extraPlugins?: BetterAuthPlugin[];
  /** Custom OAuth 2 providers from Administration (loadCustomOAuth); see holder.ts. */
  customOAuth?: CustomOAuthProvider[];
}

/** Sign-in providers configured through the environment and switched on in Settings. */
export const BUILT_IN_OAUTH = ['google', 'yandex', 'vk', 'keycloak'] as const;
export type BuiltInOAuth = (typeof BUILT_IN_OAUTH)[number];

function oauthProviders() {
  const env = process.env;
  const social: BetterAuthOptions['socialProviders'] = {};
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    social.google = { clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET };
  }
  if (env.AUTH_VK_ID && env.AUTH_VK_SECRET) {
    social.vk = { clientId: env.AUTH_VK_ID, clientSecret: env.AUTH_VK_SECRET };
  }
  const generic: GenericOAuthConfig[] = [];
  if (env.AUTH_YANDEX_ID && env.AUTH_YANDEX_SECRET)
    generic.push(yandex({ clientId: env.AUTH_YANDEX_ID, clientSecret: env.AUTH_YANDEX_SECRET }));
  // Keycloak: AUTH_KEYCLOAK_ISSUER is the realm URL, e.g. https://sso.example.org/realms/main
  if (env.AUTH_KEYCLOAK_ID && env.AUTH_KEYCLOAK_SECRET && env.AUTH_KEYCLOAK_ISSUER)
    generic.push(
      keycloak({
        clientId: env.AUTH_KEYCLOAK_ID,
        clientSecret: env.AUTH_KEYCLOAK_SECRET,
        issuer: env.AUTH_KEYCLOAK_ISSUER,
      }),
    );
  return { social, generic };
}

export function configuredOAuthProviders(): BuiltInOAuth[] {
  const env = process.env;
  const out: BuiltInOAuth[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) out.push('google');
  if (env.AUTH_YANDEX_ID && env.AUTH_YANDEX_SECRET) out.push('yandex');
  if (env.AUTH_VK_ID && env.AUTH_VK_SECRET) out.push('vk');
  if (env.AUTH_KEYCLOAK_ID && env.AUTH_KEYCLOAK_SECRET && env.AUTH_KEYCLOAK_ISSUER)
    out.push('keycloak');
  return out;
}

/** A custom provider for Better Auth's generic OAuth: claims mapped to Hubium's names. */
function customOAuthConfig(p: CustomOAuthProvider): GenericOAuthConfig {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    providerId: p.providerId,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    authorizationUrl: p.authorizationUrl,
    tokenUrl: p.tokenUrl,
    userInfoUrl: p.userInfoUrl,
    scopes: p.scopes,
    mapProfileToUser(profile) {
      const firstName = str(profile[p.mapping.firstName]);
      const lastName = str(profile[p.mapping.lastName]);
      const email = str(profile[p.mapping.email]).toLowerCase();
      return {
        ...(email ? { email } : {}),
        firstName,
        lastName,
        ...(firstName || lastName ? { name: `${firstName} ${lastName}`.trim() } : {}),
      };
    },
  };
}

const EMAIL_SIGN_IN_PATHS = new Set(['/sign-up/email', '/sign-in/email', '/sign-in/username']);

/** What the registration form sends; anything else (a username, an avatar URL, a time
 *  zone, a theme) is not the person's to choose at sign-up. */
const SIGN_UP_FIELDS = new Set([
  'email',
  'password',
  'name',
  'firstName',
  'lastName',
  'locale',
  'callbackURL',
  'rememberMe',
]);

function checkSignUpBody(raw: unknown) {
  const body = (raw ?? {}) as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !SIGN_UP_FIELDS.has(k));
  if (extra.length)
    throw new APIError('BAD_REQUEST', { message: `Unexpected fields: ${extra.join(', ')}` });
  for (const key of ['name', 'firstName', 'lastName'] as const) {
    const v = body[key];
    // as the profile form allows: 100 characters a name, the full name is both of them
    const max = key === 'name' ? 201 : 100;
    if (v !== undefined && (typeof v !== 'string' || v.trim() === '' || v.trim().length > max))
      throw new APIError('BAD_REQUEST', { message: `Invalid ${key}` });
  }
  const locale = body.locale;
  if (
    locale !== undefined &&
    (typeof locale !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(locale))
  )
    throw new APIError('BAD_REQUEST', { message: 'Invalid locale' });
}
const PASSWORD_SIGN_IN_PATHS = new Set(['/sign-in/email', '/sign-in/username']);

/** Credentials stay with their owner: not changeable from a "log in as" session. */
const CREDENTIAL_PATHS = new Set([
  '/change-email',
  '/change-password',
  '/set-password',
  '/delete-user',
  '/link-social',
  '/unlink-account',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
]);

/** Endpoints that set a password, and the body field that carries it. */
const PASSWORD_FIELDS: Record<string, string> = {
  '/sign-up/email': 'password',
  '/change-password': 'newPassword',
  '/reset-password': 'newPassword',
  '/set-password': 'newPassword',
};

export function createAuth({
  db,
  baseURL,
  secret,
  extraPlugins = [],
  customOAuth = [],
}: CreateAuthOptions) {
  const { social, generic } = oauthProviders();
  generic.push(...customOAuth.map(customOAuthConfig));
  const custom = new Map(customOAuth.map((p) => [p.providerId, p]));
  const pendingPasswordHashes = new Set<string>();
  const siteName = async () => (await getAllSettings(db))['site.name'];
  const localeOf = async (u: object) =>
    userLocale(await getAllSettings(db), (u as { locale?: string | null }).locale);

  return betterAuth({
    appName: 'Hubium LMS',
    baseURL,
    secret,
    // Transactions are required by the SSO plugin's user resolution. SSO rows come with
    // their client secret unsealed (see sso.ts).
    database: prismaAdapter(withSsoSecrets(db), { provider: 'postgresql', transaction: true }),
    // identity providers on internal hosts that SSRF_ALLOW_HOSTS allows
    trustedOrigins: () => ssoTrustedOrigins(db),
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: 'hubium',
      // the client address proxy.ts works out from TRUSTED_PROXY_HOPS
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    // On in production; AUTH_RATE_LIMIT=off for automated test runs from one IP.
    rateLimit: {
      enabled:
        process.env.AUTH_RATE_LIMIT === 'on' ||
        (process.env.NODE_ENV === 'production' && process.env.AUTH_RATE_LIMIT !== 'off'),
      storage: 'database',
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 },
    },
    user: {
      additionalFields: {
        firstName: { type: 'string', required: false, defaultValue: '' },
        lastName: { type: 'string', required: false, defaultValue: '' },
        locale: { type: 'string', required: false },
        timezone: { type: 'string', required: false },
        theme: { type: 'string', required: false },
        status: { type: 'string', required: false, input: false, defaultValue: 'ACTIVE' },
        isSiteAdmin: { type: 'boolean', required: false, input: false, defaultValue: false },
        mustChangePassword: { type: 'boolean', required: false, input: false, defaultValue: false },
        emailPlaceholder: { type: 'boolean', required: false, input: false, defaultValue: false },
      },
      changeEmail: { enabled: true },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // replaced per request from registration.requireEmailVerification (hooks.before)
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        await sendAuthEmail({
          kind: 'reset',
          to: user.email,
          url,
          locale: await localeOf(user),
          siteName: await siteName(),
          name: user.name,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      async sendVerificationEmail({ user, url }) {
        await sendAuthEmail({
          kind: 'verify',
          to: user.email,
          url,
          locale: await localeOf(user),
          siteName: await siteName(),
          name: user.name,
        });
      },
    },
    socialProviders: social,
    account: {
      accountLinking: {
        enabled: true,
        // custom providers the administrator lets sign in to accounts with the same email
        trustedProviders: customOAuth.filter((p) => p.linkByEmail).map((p) => p.providerId),
      },
    },
    hooks: {
      before: createAuthMiddleware(async (c) => {
        // Profile fields change only through Hubium's own forms, which check them. Better
        // Auth's endpoint would let anyone set a username (LDAP sign-in links accounts by
        // it), any name, an avatar URL that everyone who sees the person loads, or a time
        // zone that breaks date formatting.
        if (c.path === '/update-user') throw new APIError('NOT_FOUND');
        if (c.path === '/sign-up/email') checkSignUpBody(c.body);
        const passwordField = PASSWORD_FIELDS[c.path];
        if (passwordField) {
          const body = (c.body ?? {}) as Record<string, unknown>;
          const password = body[passwordField];
          if (typeof password === 'string') {
            // whose password it is, for the "no reuse" rule
            let userId: string | undefined;
            if (c.path === '/reset-password') {
              const token = (body.token ?? (c.query as { token?: string } | undefined)?.token) as
                | string
                | undefined;
              const v = token
                ? await db.verification.findFirst({
                    where: { identifier: `reset-password:${token}` },
                    select: { value: true },
                  })
                : null;
              userId = v?.value;
            } else if (c.path !== '/sign-up/email') {
              userId = (await getSessionFromCtx(c))?.user.id;
            }
            try {
              await assertPasswordAllowed(db, password, { userId, field: passwordField });
            } catch (e) {
              if (!(e instanceof ValidationError)) throw e;
              throw new APIError('BAD_REQUEST', {
                code: 'PASSWORD_POLICY',
                message: Object.values(e.fieldErrors ?? {})
                  .flat()
                  .join('. '),
              });
            }
          }
        }
        // "Require email verification" is a site setting: Better Auth reads the option on
        // each call, so this request's copy of the context gets the current value.
        if (EMAIL_SIGN_IN_PATHS.has(c.path)) {
          if (PASSWORD_SIGN_IN_PATHS.has(c.path)) {
            const user = await findSignInUser(db, (c.body ?? {}) as object);
            if (user && isLocked(user))
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_LOCKED',
                message: 'This account is locked after failed sign-ins',
              });
          }
          const settings = await getAllSettings(db);
          c.context.options = {
            ...c.context.options,
            emailAndPassword: {
              ...c.context.options.emailAndPassword,
              enabled: true,
              requireEmailVerification: settings['registration.requireEmailVerification'],
            },
          };
          return;
        }
        // SSO providers are managed in Administration, not through the plugin's endpoints
        if (c.path.startsWith('/sso/') && !isOpenSsoPath(c.path)) throw new APIError('NOT_FOUND');
        if (c.path === '/sign-in/sso') {
          const providerId = (c.body as { providerId?: unknown } | undefined)?.providerId;
          const p =
            typeof providerId === 'string'
              ? await db.ssoProvider.findUnique({
                  where: { providerId },
                  select: { enabled: true },
                })
              : null;
          if (!p?.enabled)
            throw new APIError('FORBIDDEN', { message: 'This sign-in method is disabled' });
          return;
        }
        // The admin plugin is here for its impersonation session only; Hubium manages
        // users itself (its other endpoints check User.role, which Hubium does not use).
        if (c.path.startsWith('/admin/') && c.path !== '/admin/stop-impersonating')
          throw new APIError('NOT_FOUND');
        if (CREDENTIAL_PATHS.has(c.path)) {
          const s = await getSessionFromCtx(c);
          if (impersonatedBy(s?.session))
            throw new APIError('FORBIDDEN', {
              message: 'Not available while logged in as another user',
            });
          return;
        }
        // Providers switched off in Admin → Settings stay off even when their keys are set.
        // Generic OAuth providers (Yandex, Keycloak, custom) use the social endpoints too.
        const body = (c.body ?? {}) as { provider?: string };
        const params = (c.params ?? {}) as { id?: string };
        const provider =
          c.path === '/sign-in/social' || c.path === '/link-social'
            ? body.provider
            : c.path.startsWith('/callback/')
              ? params.id
              : undefined;
        if (provider && custom.has(provider)) {
          // read now: this instance may predate a change made a moment ago
          const row = await db.ssoProvider.findUnique({
            where: { providerId: provider },
            select: { enabled: true },
          });
          if (!row?.enabled)
            throw new APIError('FORBIDDEN', { message: 'This sign-in method is disabled' });
          return;
        }
        if (!(BUILT_IN_OAUTH as readonly string[]).includes(provider ?? '')) return;
        const settings = await getAllSettings(db);
        if (!settings[`auth.oauth.${provider as BuiltInOAuth}`])
          throw new APIError('FORBIDDEN', { message: 'This sign-in method is disabled' });
      }),
      after: createAuthMiddleware(async (c) => {
        const r = c.context.returned;
        // recovery phrases belong to two-factor authentication
        if (c.path === '/two-factor/disable' && !(r instanceof APIError)) {
          const s = await getSessionFromCtx(c);
          if (s) await dropRecoveryPassphrases(db, s.user.id);
          return;
        }
        // a wrong password counts towards the lockout (auth/lockout.ts)
        if (!PASSWORD_SIGN_IN_PATHS.has(c.path)) return;
        if (!(r instanceof APIError) || r.statusCode !== 401) return;
        const user = await findSignInUser(db, (c.body ?? {}) as object);
        if (user)
          await recordFailedSignIn(db, user.id, {
            appUrl: baseURL,
            ip: clientIp(c.headers?.get('x-forwarded-for') ?? null),
          });
      }),
    },
    databaseHooks: {
      // Every password Better Auth stores (sign-up, change, reset) is remembered for the
      // password policy. Updates go through updateMany, whose hook does not see the row,
      // so the new hash itself identifies the account afterwards.
      account: {
        create: {
          // a custom provider that must not sign in to existing accounts by email: an
          // account linked to a user who already has others is such a link
          async before(account) {
            const p = custom.get(account.providerId);
            if (!p || p.linkByEmail) return { data: account };
            const others = await db.account.count({ where: { userId: account.userId } });
            return others ? false : { data: account };
          },
          async after(account) {
            if (account.password) await recordPasswordChange(db, account.userId);
          },
        },
        update: {
          async before(data) {
            if (typeof data.password === 'string') pendingPasswordHashes.add(data.password);
            return { data };
          },
          async after() {
            for (const hash of [...pendingPasswordHashes]) {
              const acc = await db.account.findFirst({
                where: { password: hash, providerId: 'credential' },
                select: { userId: true },
              });
              if (!acc) continue;
              pendingPasswordHashes.delete(hash);
              await recordPasswordChange(db, acc.userId);
            }
          },
        },
      },
      user: {
        create: {
          async before(user, context) {
            const settings = await getAllSettings(db);
            // OAuth sign-ups count as registration; respect the site switch. SSO providers
            // decide for themselves (resolveSsoUser in sso.ts).
            // custom OAuth 2 providers have their own switch
            const viaSso = context?.path?.startsWith('/sso/') ?? false;
            const customProvider = context?.path?.startsWith('/callback/')
              ? custom.get(String((context.params as { id?: string }).id))
              : undefined;
            if (
              customProvider
                ? !customProvider.autoCreate
                : !viaSso && !settings['registration.enabled']
            ) {
              throw new Error('Registration is disabled');
            }
            const name = String(user.name ?? '').trim();
            const [first, ...rest] = name.split(/\s+/);
            return {
              data: {
                ...user,
                firstName: (user as { firstName?: string }).firstName || first || '',
                lastName: (user as { lastName?: string }).lastName || rest.join(' '),
              },
            };
          },
        },
        update: {
          // someone created without an email who confirmed one of their own (change email)
          // has a real address now: letters go to it and it shows again
          async after(user) {
            if (user.email.endsWith('@users.invalid')) return;
            await db.user.updateMany({
              where: { id: user.id, emailPlaceholder: true },
              data: { emailPlaceholder: false },
            });
          },
        },
      },
      session: {
        create: {
          async before(session) {
            const u = await db.user.findUnique({
              where: { id: session.userId },
              select: { status: true },
            });
            // a user created in the same transaction (SSO) is not visible here yet, and new
            // users are active
            if (u && u.status !== 'ACTIVE') return false;
            return { data: session };
          },
          async after(session) {
            // logging in as someone is not that person's login
            if (impersonatedBy(session)) return;
            await clearFailedSignIns(db, session.userId);
            await noteSignIn(db, session);
            const user = await db.user.update({
              where: { id: session.userId },
              data: { lastLoginAt: new Date() },
              select: { passwordChangedAt: true, mustChangePassword: true },
            });
            // an expired password has to be changed before going on (see the (gate) layout)
            const policy = passwordPolicy(await getAllSettings(db));
            if (!user.mustChangePassword && passwordExpired(policy, user.passwordChangedAt))
              await db.user.update({
                where: { id: session.userId },
                data: { mustChangePassword: true },
              });
          },
        },
      },
    },
    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 50 }),
      // The settings page swaps in the site name before showing the QR code.
      twoFactor({ issuer: 'Hubium LMS' }),
      admin({ defaultRole: 'user', adminRoles: [] }),
      loginAs(db),
      recoveryPassphrase(db, baseURL),
      ssoPlugin(db),
      ldapSignIn(db, baseURL),
      ...(generic.length ? [genericOAuth({ config: generic })] : []),
      ...extraPlugins,
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
