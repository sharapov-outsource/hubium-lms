import 'server-only';
import {
  type Actor,
  accountGate,
  anonymousAccess,
  type Capability,
  clientIp,
  ForbiddenError,
  gateError,
  isSwitchableRole,
  loadUserAccess,
  NotFoundError,
  noteUserAccess,
  Permissions,
  type RequestContext,
} from '@hubium/core';
import { log } from '@hubium/log';
import { cookies, headers } from 'next/headers';
import { forbidden, notFound, redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { cache } from 'react';
import { auth } from './auth';
import { db } from './db';

const logger = log('web');

export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export const getCurrentUser = cache(async () => {
  const session = await getSession();
  if (!session) return null;
  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (user?.status !== 'ACTIVE') return null;
  // an administrator logged in as the user is not the user's visit
  if (!session.session.impersonatedBy)
    await noteUserAccess(db, user).catch((err) =>
      logger.warn({ err, userId: user.id }, 'Could not record the last visit'),
    );
  return user;
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** Refuses while the signed-in person has a step to take first (accountGate). */
export async function requireNoGate(): Promise<void> {
  const ctx = await getContext();
  // while logged in as someone, their steps stay theirs
  if (ctx.actor.kind !== 'user' || ctx.actor.realUserId) return;
  const user = await getCurrentUser();
  const gate = user ? await accountGate(db, user) : null;
  if (gate) throw gateError(gate);
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * A request context built now, with the permissions the person has now: for the step after
 * an operation that gave them a role (the author of a new course), which the context of the
 * request, built before it, does not know.
 */
export async function freshContext(): Promise<RequestContext> {
  const user = await getCurrentUser();
  const h = await headers();
  const ip = clientIp(h.get('x-forwarded-for'));
  const locale = await getLocale();
  if (!user) {
    return {
      db,
      actor: { kind: 'anonymous' },
      perm: new Permissions(db, await anonymousAccess(db)),
      now: new Date(),
      locale,
      ip,
      origin: 'WEB',
    };
  }
  const session = await getSession();
  const actor: Actor = {
    kind: 'user',
    userId: user.id,
    isSiteAdmin: user.isSiteAdmin,
    realUserId: session?.session.impersonatedBy ?? undefined,
  };
  const switchedRole = await readSwitchedRole(user.id);
  return {
    db,
    actor,
    perm: new Permissions(db, await loadUserAccess(db, user, { switchedRole })),
    now: new Date(),
    locale,
    ip,
    origin: 'WEB',
  };
}

/** Request context for core services, built once per request. */
export const getContext = cache(freshContext);

export const VIEW_AS_COOKIE = 'hubium-viewas';

/** "View as role" switch, honoured only when the user may switch roles in that course. */
async function readSwitchedRole(
  userId: string,
): Promise<{ roleId: string; contextId: string } | undefined> {
  const raw = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  if (!raw) return undefined;
  const [contextId, roleId] = raw.split(':');
  if (!contextId || !roleId) return undefined;
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return undefined;
  const real = new Permissions(db, await loadUserAccess(db, user));
  if (!(await real.can('course:switchrole', contextId).catch(() => false))) return undefined;
  // The cookie is client-held: only preview as a weaker role, never e.g. manager.
  if (!(await isSwitchableRole(db, contextId, roleId))) return undefined;
  return { roleId, contextId };
}

export async function getSwitchedRole(): Promise<{ roleId: string; contextId: string } | null> {
  const user = await getCurrentUser();
  return user ? ((await readSwitchedRole(user.id)) ?? null) : null;
}

/** For pages: signed-in user holding the capability, else 403 page. */
export async function requireCapability(cap: Capability, contextId?: string) {
  const user = await requireUser();
  const ctx = await getContext();
  if (!(await ctx.perm.can(cap, contextId))) forbidden();
  return { user, ctx };
}

/**
 * For pages: what the core gives, its refusals shown as the 403 and 404 pages rather than
 * as an error (a link from an old email to a course one has left).
 */
export async function orRefused<T>(data: Promise<T>): Promise<T> {
  try {
    return await data;
  } catch (e) {
    if (e instanceof ForbiddenError) forbidden();
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
}
