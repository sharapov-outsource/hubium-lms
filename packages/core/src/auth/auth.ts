import { type Db, uuidv7 } from '@hubium/db';
import { isLocale } from '@hubium/i18n';
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, twoFactor, username } from 'better-auth/plugins';
import { genericOAuth, yandex } from 'better-auth/plugins/generic-oauth';
import { sendAuthEmail } from '../mail/mail.ts';
import { getAllSettings } from '../settings/settings.ts';

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

export function createAuth({ db, baseURL, secret, extraPlugins = [] }: CreateAuthOptions) {
  const { social, generic } = oauthProviders();
  const siteName = async () => (await getAllSettings(db))['site.name'];
  const localeOf = (u: object) => {
    const l = (u as { locale?: unknown }).locale;
    return isLocale(l) ? l : 'ru';
  };

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
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        await sendAuthEmail({
          kind: 'reset',
          to: user.email,
          url,
          locale: localeOf(user),
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
          locale: localeOf(user),
          siteName: await siteName(),
          name: user.name,
        });
      },
    },
    socialProviders: social,
    hooks: {
      // Providers switched off in Admin → Settings stay off even when their keys are set.
      before: createAuthMiddleware(async (c) => {
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
    },
    databaseHooks: {
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
            await db.user.update({
              where: { id: session.userId },
              data: { lastLoginAt: new Date() },
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
      ...(generic.length ? [genericOAuth({ config: generic })] : []),
      ...extraPlugins,
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
