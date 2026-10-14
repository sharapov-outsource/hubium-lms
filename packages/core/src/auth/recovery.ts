import type { Db } from '@hubium/db';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { expireCookie, setSessionCookie } from 'better-auth/cookies';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { sendAuthEmail } from '../mail/mail.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings, userLocale } from '../settings/settings.ts';

// Recovery passphrases: with two-factor authentication on, a user keeps a few phrases of
// their own (written down, in a safe) to sign in when the authenticator device is lost.
// Each phrase works once instead of a code; using one emails the owner. They are hashed
// like passwords, and failures count towards Better Auth's two-factor lockout.

export const MAX_RECOVERY_PASSPHRASES = 5;
const MIN_WORDS = 4;
const MIN_LENGTH = 20;
// Better Auth's defaults for its two-factor lockout (the same TwoFactor columns)
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60_000;

/** Case, spacing and Unicode forms do not matter when typing a phrase from paper. */
export function normalizePassphrase(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function passphraseProblems(raw: string): string[] {
  const s = normalizePassphrase(raw);
  const out: string[] = [];
  if (s.split(' ').filter(Boolean).length < MIN_WORDS) out.push(`At least ${MIN_WORDS} words`);
  if (s.length < MIN_LENGTH) out.push(`At least ${MIN_LENGTH} characters`);
  if (s.length > 200) out.push('At most 200 characters');
  return out;
}

function ownUser(ctx: RequestContext): string {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError('Sign in required');
  // credentials stay with their owner, as in auth.ts
  if (ctx.actor.realUserId)
    throw new ForbiddenError('Not available while logged in as another user');
  return ctx.actor.userId;
}

export async function listRecoveryPassphrases(ctx: RequestContext) {
  const userId = ownUser(ctx);
  return ctx.db.recoveryPassphrase.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, createdAt: true },
  });
}

export const addRecoveryPassphrase = defineOperation({
  name: 'user.addRecoveryPassphrase',
  input: z.object({
    name: z.string().trim().min(1).max(100),
    passphrase: z.string().max(500),
    password: z.string().max(200),
  }),
  async handler(ctx, input) {
    const userId = ownUser(ctx);
    const user = await ctx.tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { twoFactorEnabled: true },
    });
    if (!user.twoFactorEnabled)
      throw new ValidationError({ passphrase: ['Turn on two-factor authentication first'] });
    const account = await ctx.tx.account.findFirst({
      where: { userId, providerId: 'credential' },
      select: { password: true },
    });
    if (
      !account?.password ||
      !(await verifyPassword({ hash: account.password, password: input.password }))
    )
      throw new ValidationError({ password: ['Invalid password'] });
    const problems = passphraseProblems(input.passphrase);
    if (problems.length) throw new ValidationError({ passphrase: problems });
    if ((await ctx.tx.recoveryPassphrase.count({ where: { userId } })) >= MAX_RECOVERY_PASSPHRASES)
      throw new ValidationError({ name: [`At most ${MAX_RECOVERY_PASSPHRASES} phrases`] });
    const row = await ctx.tx.recoveryPassphrase.create({
      data: {
        userId,
        name: input.name,
        hash: await hashPassword(normalizePassphrase(input.passphrase)),
      },
    });
    await logEvent(ctx.tx, {
      name: 'user.recoveryPassphraseAdded',
      actorId: userId,
      relatedUserId: userId,
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { id: row.id };
  },
});

export const deleteRecoveryPassphrase = defineOperation({
  name: 'user.deleteRecoveryPassphrase',
  input: z.object({ id: z.string().uuid() }),
  async handler(ctx, { id }) {
    const userId = ownUser(ctx);
    await ctx.tx.recoveryPassphrase.deleteMany({ where: { id, userId } });
    return { id };
  },
});

/** Two-factor turned off: the phrases go with it. */
export async function dropRecoveryPassphrases(db: Db, userId: string): Promise<void> {
  await db.recoveryPassphrase.deleteMany({ where: { userId } });
}

/**
 * Better Auth plugin: POST /two-factor/verify-passphrase finishes a two-factor sign-in with
 * a recovery phrase, like /two-factor/verify-backup-code does with a backup code.
 */
export function recoveryPassphrase(db: Db, appUrl: string) {
  return {
    id: 'hubium-recovery-passphrase',
    endpoints: {
      verifyRecoveryPassphrase: createAuthEndpoint(
        '/two-factor/verify-passphrase',
        { method: 'POST', body: z.object({ passphrase: z.string().max(500) }) },
        async (ctx) => {
          const invalid = () =>
            new APIError('UNAUTHORIZED', {
              code: 'INVALID_RECOVERY_PASSPHRASE',
              message: 'Invalid recovery passphrase',
            });
          // the pending sign-in that asked for a second factor (Better Auth's cookie)
          const cookie = ctx.context.createAuthCookie('two_factor');
          const key = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          const pending = key ? await ctx.context.internalAdapter.findVerificationValue(key) : null;
          if (!key || !pending || pending.expiresAt < new Date())
            throw new APIError('UNAUTHORIZED', {
              code: 'INVALID_TWO_FACTOR_COOKIE',
              message: 'Sign in again',
            });
          const userId = pending.value;
          const tf = await db.twoFactor.findFirst({ where: { userId } });
          if (!tf) throw invalid();
          if (tf.lockedUntil && tf.lockedUntil > new Date())
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'ACCOUNT_TEMPORARILY_LOCKED',
              message: 'Too many attempts',
            });

          const phrase = normalizePassphrase(ctx.body.passphrase);
          let match: string | null = null;
          for (const p of await db.recoveryPassphrase.findMany({ where: { userId } })) {
            if (await verifyPassword({ hash: p.hash, password: phrase })) {
              match = p.id;
              break;
            }
          }
          if (!match) {
            const r = await db.twoFactor.update({
              where: { id: tf.id },
              data: { failedVerificationCount: { increment: 1 } },
            });
            if ((r.failedVerificationCount ?? 0) >= MAX_FAILURES)
              await db.twoFactor.update({
                where: { id: tf.id },
                data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
              });
            throw invalid();
          }
          // one use: a parallel request with the same phrase finds it gone
          const used = await db.recoveryPassphrase.deleteMany({ where: { id: match } });
          if (!used.count) throw invalid();
          await db.twoFactor.update({
            where: { id: tf.id },
            data: { failedVerificationCount: 0, lockedUntil: null },
          });
          await ctx.context.internalAdapter.consumeVerificationValue(key);
          const user = await ctx.context.internalAdapter.findUserById(userId);
          const session = user
            ? await ctx.context.internalAdapter.createSession(userId, false)
            : null;
          if (!user || !session)
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not start the session' });
          await setSessionCookie(ctx, { session, user });
          expireCookie(ctx, cookie);

          await logEvent(db, {
            name: 'user.recoveryPassphraseUsed',
            actorId: userId,
            relatedUserId: userId,
            objectType: 'user',
            objectId: userId,
          });
          const row = await db.user.findUniqueOrThrow({
            where: { id: userId },
            select: { email: true, emailPlaceholder: true, name: true, locale: true },
          });
          if (!row.emailPlaceholder) {
            const settings = await getAllSettings(db);
            await sendAuthEmail({
              kind: 'recoveryUsed',
              to: row.email,
              url: `${appUrl}/settings/security`,
              locale: userLocale(settings, row.locale),
              siteName: settings['site.name'],
              name: row.name,
            });
          }
          return ctx.json({ token: session.token });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
