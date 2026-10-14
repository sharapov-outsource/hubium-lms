import { type Db, uuidv7 } from '@hubium/db';
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { admin, twoFactor, username } from 'better-auth/plugins';
import { genericOAuth, yandex } from 'better-auth/plugins/generic-oauth';
import { clientIp } from '../client-ip.ts';
import { ValidationError } from '../errors.ts';
import { sendAuthEmail } from '../mail/mail.ts';
import { getAllSettings, userLocale } from '../settings/settings.ts';
import { noteSignIn } from './devices.ts';
import { clearFailedSignIns, findSignInUser, isLocked, recordFailedSignIn } from './lockout.ts';
import { impersonatedBy, loginAs } from './login-as.ts';
import {
  assertPasswordAllowed,
  passwordExpired,
  passwordPolicy,
  recordPasswordChange,
} from './password-policy.ts';
import { dropRecoveryPassphrases, recoveryPassphrase } from './recovery.ts';

// Better Auth instance. Authentication only — authorization is Hubium's own (can()).

export interface CreateAuthOptions {
  db: Db;
  baseURL: string;
  secret: string;
  /** Framework plugins (e.g. nextCookies) appended last. */
  extraPlugins?: BetterAuthPlugin[];
}

function oauthProviders() {
  const env = process.env;
  const social: BetterAuthOptions['socialProviders'] = {};
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    social.google = { clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET };
  }
  if (env.AUTH_VK_ID && env.AUTH_VK_SECRET) {
    social.vk = { clientId: env.AUTH_VK_ID, clientSecret: env.AUTH_VK_SECRET };
  }
  const generic =
    env.AUTH_YANDEX_ID && env.AUTH_YANDEX_SECRET
      ? [yandex({ clientId: env.AUTH_YANDEX_ID, clientSecret: env.AUTH_YANDEX_SECRET })]
      : [];
  return { social, generic };
}

export function configuredOAuthProviders(): ('google' | 'yandex' | 'vk')[] {
  const env = process.env;
  const out: ('google' | 'yandex' | 'vk')[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) out.push('google');
  if (env.AUTH_YANDEX_ID && env.AUTH_YANDEX_SECRET) out.push('yandex');
  if (env.AUTH_VK_ID && env.AUTH_VK_SECRET) out.push('vk');
  return out;
}

const EMAIL_SIGN_IN_PATHS = new Set(['/sign-up/email', '/sign-in/email', '/sign-in/username']);
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

export function createAuth({ db, baseURL, secret, extraPlugins = [] }: CreateAuthOptions) {
  const { social, generic } = oauthProviders();
  const pendingPasswordHashes = new Set<string>();
  const siteName = async () => (await getAllSettings(db))['site.name'];
  const localeOf = async (u: object) =>
    userLocale(await getAllSettings(db), (u as { locale?: string | null }).locale);

  return betterAuth({
    appName: 'Hubium LMS',
    baseURL,
    secret,
    database: prismaAdapter(db, { provider: 'postgresql' }),
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: 'hubium',
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
    hooks: {
      before: createAuthMiddleware(async (c) => {
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
        const body = (c.body ?? {}) as { provider?: string; providerId?: string };
        const params = (c.params ?? {}) as { id?: string; providerId?: string };
        const provider =
          c.path === '/sign-in/social' || c.path === '/link-social'
            ? body.provider
            : c.path === '/sign-in/oauth2' || c.path === '/oauth2/link'
              ? body.providerId
              : c.path.startsWith('/callback/')
                ? params.id
                : c.path.startsWith('/oauth2/callback/')
                  ? params.providerId
                  : undefined;
        if (provider !== 'google' && provider !== 'yandex' && provider !== 'vk') return;
        const settings = await getAllSettings(db);
        if (!settings[`auth.oauth.${provider}`])
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
          async before(user) {
            const settings = await getAllSettings(db);
            // OAuth sign-ups count as registration; respect the site switch.
            if (!settings['registration.enabled']) {
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
      },
      session: {
        create: {
          async before(session) {
            const u = await db.user.findUnique({
              where: { id: session.userId },
              select: { status: true },
            });
            if (u?.status !== 'ACTIVE') return false;
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
      ...(generic.length ? [genericOAuth({ config: generic })] : []),
      ...extraPlugins,
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
