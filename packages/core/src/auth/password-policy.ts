import type { Db, Prisma } from '@hubium/db';
import { type Msg, msg } from '@hubium/module-sdk';
import { verifyPassword } from 'better-auth/crypto';
import { ValidationError } from '../errors.ts';
import { type AllSettings, getAllSettings } from '../settings/settings.ts';

// Password policy from Administration → Settings → Security. It is checked wherever a
// password is set (sign-up, change, reset, admin forms, CSV upload, REST) and never at
// sign-in, so existing passwords keep working until they are changed or expire.

type Tx = Prisma.TransactionClient | Db;

export const MAX_PASSWORD_LENGTH = 128;

export interface PasswordPolicy {
  minLength: number;
  requireDigit: boolean;
  requireLower: boolean;
  requireUpper: boolean;
  requireSymbol: boolean;
  history: number;
  maxAgeDays: number;
}

export function passwordPolicy(s: AllSettings): PasswordPolicy {
  return {
    minLength: s['password.minLength'],
    requireDigit: s['password.requireDigit'],
    requireLower: s['password.requireLower'],
    requireUpper: s['password.requireUpper'],
    requireSymbol: s['password.requireSymbol'],
    history: s['password.history'],
    maxAgeDays: s['password.maxAgeDays'],
  };
}

/** The rules a password breaks, as messages (empty when it is fine). */
export function passwordProblems(policy: PasswordPolicy, password: string): Msg[] {
  const out: Msg[] = [];
  if (password.length < policy.minLength)
    out.push(msg('errors.field.tooShort', { n: policy.minLength }));
  if (password.length > MAX_PASSWORD_LENGTH)
    out.push(msg('errors.field.tooLong', { n: MAX_PASSWORD_LENGTH }));
  if (policy.requireDigit && !/\p{Nd}/u.test(password)) out.push(msg('errors.auth.password.digit'));
  if (policy.requireLower && !/\p{Ll}/u.test(password)) out.push(msg('errors.auth.password.lower'));
  if (policy.requireUpper && !/\p{Lu}/u.test(password)) out.push(msg('errors.auth.password.upper'));
  if (policy.requireSymbol && !/[^\p{L}\p{Nd}\s]/u.test(password))
    out.push(msg('errors.auth.password.symbol'));
  return out;
}

/** Hashes to compare a new password with: the current one and the remembered earlier ones. */
async function recentHashes(db: Tx, userId: string, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const [current, older] = await Promise.all([
    db.account.findFirst({
      where: { userId, providerId: 'credential' },
      select: { password: true },
    }),
    db.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: count,
      select: { hash: true },
    }),
  ]);
  const hashes = older.map((h) => h.hash);
  if (current?.password && !hashes.includes(current.password)) hashes.unshift(current.password);
  return hashes.slice(0, count);
}

/**
 * Throws a ValidationError on `field` when the password breaks the policy, or when it is
 * one of the user's last passwords (pass `userId` when the password is being changed).
 */
export async function assertPasswordAllowed(
  db: Tx,
  password: string,
  opts: { userId?: string; field?: string } = {},
): Promise<void> {
  const field = opts.field ?? 'password';
  const policy = passwordPolicy(await getAllSettings(db));
  const problems = passwordProblems(policy, password);
  if (problems.length) throw new ValidationError({ [field]: problems });
  if (!opts.userId) return;
  for (const hash of await recentHashes(db, opts.userId, policy.history)) {
    if (await verifyPassword({ hash, password }))
      throw new ValidationError({ [field]: [msg('errors.auth.passwordReused')] });
  }
}

/**
 * Records that the user's local password has just been set: remembers its hash for the
 * "no reuse" rule and restarts the expiry clock. Call after every password change.
 */
export async function recordPasswordChange(db: Tx, userId: string): Promise<void> {
  const acc = await db.account.findFirst({
    where: { userId, providerId: 'credential' },
    select: { password: true },
  });
  if (!acc?.password) return;
  await db.user.update({ where: { id: userId }, data: { passwordChangedAt: new Date() } });
  await db.passwordHistory.create({ data: { userId, hash: acc.password } });
  // keep only as many as the largest allowed policy needs
  const stale = await db.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip: 20,
    select: { id: true },
  });
  if (stale.length)
    await db.passwordHistory.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
}

/** True when the policy has a maximum age and the user's password is older than that. */
export function passwordExpired(
  policy: PasswordPolicy,
  changedAt: Date | null,
  now = new Date(),
): boolean {
  if (!policy.maxAgeDays || !changedAt) return false;
  return now.getTime() - changedAt.getTime() > policy.maxAgeDays * 86_400_000;
}
