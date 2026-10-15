import { msg } from '@hubium/module-sdk';
import type { RequestContext } from '../context.ts';
import { ValidationError } from '../errors.ts';

/**
 * People named by email or login, one per line or separated by commas. `allowed` first
 * checks that the caller may run the operation they are named for: "not found" must not
 * tell anyone else whether an address has an account here.
 */
export async function resolveLogins(
  ctx: RequestContext,
  text: string | undefined,
  opts: { allowed: () => Promise<void>; field: string },
): Promise<string[]> {
  await opts.allowed();
  const logins = [
    ...new Set(
      (text ?? '')
        .split(/[\s,;]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!logins.length) return [];
  const users = await ctx.db.user.findMany({
    where: { OR: [{ email: { in: logins } }, { username: { in: logins } }], deletedAt: null },
    select: { id: true, email: true, username: true },
  });
  const unknown = logins.filter(
    (l) => !users.some((u) => u.email.toLowerCase() === l || u.username?.toLowerCase() === l),
  );
  if (unknown.length)
    throw new ValidationError({
      [opts.field]: [msg('errors.users.notFoundList', { unknown: unknown.join(', ') })],
    });
  return users.map((u) => u.id);
}
