import { randomBytes } from 'node:crypto';
import type { Db, Prisma } from '@hubium/db';
import { logEvent } from '../events/log.ts';
import { sendAuthEmail } from '../mail/mail.ts';
import { type AllSettings, getAllSettings, userLocale } from '../settings/settings.ts';

// Account lockout, as in Moodle: so many failed sign-ins within a window lock the account
// for a while. The owner gets an email with a link that unlocks it at once; administrators
// unlock from the user's page. The per-IP rate limit of Better Auth stays in front of this.

type Tx = Prisma.TransactionClient | Db;

const UNLOCK_PREFIX = 'unlock-account:';

export interface LockoutPolicy {
  threshold: number;
  windowMinutes: number;
  durationMinutes: number;
}

export function lockoutPolicy(s: AllSettings): LockoutPolicy {
  return {
    threshold: s['lockout.threshold'],
    windowMinutes: s['lockout.windowMinutes'],
    durationMinutes: s['lockout.durationMinutes'],
  };
}

/** The account a sign-in form names, by email or username. */
export async function findSignInUser(
  db: Tx,
  body: { email?: unknown; username?: unknown },
): Promise<{ id: string; lockedUntil: Date | null } | null> {
  const select = { id: true, lockedUntil: true } as const;
  if (typeof body.email === 'string')
    return db.user.findUnique({ where: { email: body.email.trim().toLowerCase() }, select });
  if (typeof body.username === 'string')
    return db.user.findUnique({ where: { username: body.username.trim().toLowerCase() }, select });
  return null;
}

export function isLocked(user: { lockedUntil: Date | null }, now = new Date()): boolean {
  return !!user.lockedUntil && user.lockedUntil > now;
}

/**
 * Counts a failed sign-in. Locks the account once the count within the window reaches the
 * threshold, logs it and emails the owner an unlock link. Returns the lock end, if locked.
 */
export async function recordFailedSignIn(
  db: Db,
  userId: string,
  opts: { appUrl: string; ip?: string | null; now?: Date } = { appUrl: '' },
): Promise<Date | null> {
  const settings = await getAllSettings(db);
  const policy = lockoutPolicy(settings);
  if (!policy.threshold) return null;
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - policy.windowMinutes * 60_000);
  // one statement, so parallel attempts each count
  const [row] = await db.$queryRaw<{ failedLoginCount: number }[]>`
    UPDATE "User" SET
      "failedLoginCount" = CASE WHEN "failedLoginAt" IS NULL OR "failedLoginAt" < ${windowStart}
        THEN 1 ELSE "failedLoginCount" + 1 END,
      "failedLoginAt" = CASE WHEN "failedLoginAt" IS NULL OR "failedLoginAt" < ${windowStart}
        THEN ${now} ELSE "failedLoginAt" END
    WHERE id = ${userId}::uuid AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})
    RETURNING "failedLoginCount"`;
  if (!row || row.failedLoginCount < policy.threshold) return null;

  const until = new Date(now.getTime() + policy.durationMinutes * 60_000);
  const user = await db.user.update({
    where: { id: userId },
    data: { lockedUntil: until, failedLoginCount: 0, failedLoginAt: null },
    select: { email: true, emailPlaceholder: true, name: true, locale: true },
  });
  await logEvent(db, {
    name: 'user.locked',
    relatedUserId: userId,
    objectType: 'user',
    objectId: userId,
    ip: opts.ip ?? undefined,
    data: { until: until.toISOString(), attempts: row.failedLoginCount },
  });
  if (!user.emailPlaceholder) {
    const token = randomBytes(32).toString('base64url');
    await db.verification.create({
      data: { identifier: `${UNLOCK_PREFIX}${token}`, value: userId, expiresAt: until },
    });
    await sendAuthEmail({
      kind: 'locked',
      to: user.email,
      url: `${opts.appUrl}/unlock-account?token=${token}`,
      locale: userLocale(settings, user.locale),
      siteName: settings['site.name'],
      name: user.name,
      values: { minutes: policy.durationMinutes },
    });
  }
  return until;
}

/** A successful sign-in starts the count again. */
export async function clearFailedSignIns(db: Tx, userId: string): Promise<void> {
  await db.user.updateMany({
    where: { id: userId, OR: [{ failedLoginCount: { gt: 0 } }, { lockedUntil: { not: null } }] },
    data: { failedLoginCount: 0, failedLoginAt: null, lockedUntil: null },
  });
}

/** Lifts a lock; used by administrators and by the emailed link. */
export async function unlockAccount(db: Tx, userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, failedLoginAt: null, lockedUntil: null },
  });
  await db.verification.deleteMany({
    where: { identifier: { startsWith: UNLOCK_PREFIX }, value: userId },
  });
}

/** Unlocks the account of an emailed link. False when the link is unknown or expired. */
export async function unlockWithToken(db: Db, token: string): Promise<boolean> {
  const v = await db.verification.findFirst({
    where: { identifier: `${UNLOCK_PREFIX}${token}`, expiresAt: { gt: new Date() } },
  });
  if (!v) return false;
  await unlockAccount(db, v.value);
  await logEvent(db, {
    name: 'user.unlocked',
    actorId: v.value,
    relatedUserId: v.value,
    objectType: 'user',
    objectId: v.value,
    data: { via: 'email' },
  });
  return true;
}
