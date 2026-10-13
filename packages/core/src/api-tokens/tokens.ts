import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '@hubium/db';
import { defaultLocale, isLocale, type Locale } from '@hubium/i18n';
import { z } from 'zod';
import { loadUserAccess, Permissions } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';

// Personal access tokens for the REST API. The secret is shown once; only its SHA-256 is
// stored. A token acts as its user, narrowed by scopes:
//   read  — GET endpoints
//   write — mutations (still subject to the user's capabilities)

export const API_SCOPES = ['read', 'write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

const PREFIX = 'hub_';
const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export const CreateTokenInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1).default(['read']),
  expiresInDays: z.coerce.number().int().min(1).max(3650).nullable().default(90),
});

function requireUser(ctx: RequestContext): string {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  return ctx.actor.userId;
}

export async function createApiToken(ctx: RequestContext, raw: unknown) {
  const userId = requireUser(ctx);
  if (ctx.actor.kind === 'user' && ctx.actor.realUserId)
    throw new ForbiddenError('Not available while logged in as another user');
  // A token can never do more than a browser session; API access itself is a capability.
  await ctx.perm.require('webservice:createtoken');
  const input = CreateTokenInput.parse(raw);
  const active = await ctx.db.apiToken.count({ where: { userId, revokedAt: null } });
  if (active >= 20) throw new ValidationError({ name: ['At most 20 active tokens'] });
  const secret = randomBytes(24).toString('base64url');
  const prefix = secret.slice(0, 8);
  const token = `${PREFIX}${secret}`;
  const row = await ctx.db.apiToken.create({
    data: {
      userId,
      name: input.name,
      prefix,
      tokenHash: hashToken(token),
      scopes: input.scopes,
      expiresAt: input.expiresInDays
        ? new Date(ctx.now.getTime() + input.expiresInDays * 86_400_000)
        : null,
    },
  });
  await logEvent(ctx.db, {
    name: 'apitoken.created',
    actorId: userId,
    objectType: 'apiToken',
    objectId: row.id,
    origin: ctx.origin,
    ip: ctx.ip,
  });
  return { id: row.id, token, prefix, scopes: row.scopes, expiresAt: row.expiresAt };
}

export async function listApiTokens(ctx: RequestContext) {
  const userId = requireUser(ctx);
  return ctx.db.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
}

export async function revokeApiToken(ctx: RequestContext, id: string) {
  const userId = requireUser(ctx);
  const t = await ctx.db.apiToken.findUnique({ where: { id } });
  if (!t || (t.userId !== userId && !(await ctx.perm.can('site:config'))))
    throw new NotFoundError('Token');
  await ctx.db.apiToken.update({ where: { id }, data: { revokedAt: ctx.now } });
  return { id };
}

/**
 * Resolves `Authorization: Bearer hub_...` to a request context, or null when the token
 * is unknown, revoked, expired or its user is suspended/deleted.
 */
export async function authenticateApiToken(
  db: Db,
  raw: string,
  meta: { ip?: string | null; locale?: Locale; now?: Date } = {},
): Promise<{ ctx: RequestContext; scopes: ApiScope[]; tokenId: string } | null> {
  if (!raw.startsWith(PREFIX) || raw.length > 200) return null;
  const now = meta.now ?? new Date();
  const t = await db.apiToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: true },
  });
  if (!t || t.revokedAt || (t.expiresAt && t.expiresAt <= now)) return null;
  const u = t.user;
  if (u.deletedAt || u.status !== 'ACTIVE') return null;
  // Throttle the "last used" write to once a minute per token.
  if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() > 60_000)
    await db.apiToken.update({
      where: { id: t.id },
      data: { lastUsedAt: now, lastUsedIp: meta.ip ?? null },
    });
  const perm = new Permissions(db, await loadUserAccess(db, u));
  // Losing API access (e.g. a PROHIBIT on the role) disables existing tokens too.
  if (!(await perm.can('webservice:createtoken'))) return null;
  return {
    tokenId: t.id,
    scopes: t.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
    ctx: {
      db,
      actor: { kind: 'user', userId: u.id, isSiteAdmin: u.isSiteAdmin },
      perm,
      now,
      locale: meta.locale ?? (isLocale(u.locale) ? u.locale : defaultLocale),
      ip: meta.ip ?? null,
      origin: 'API',
    },
  };
}
