import 'server-only';
import {
  type Actor,
  anonymousAccess,
  type Capability,
  isSwitchableRole,
  loadUserAccess,
  Permissions,
  type RequestContext,
} from '@hubium/core';
import { cookies, headers } from 'next/headers';
import { forbidden, redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { cache } from 'react';
import { auth } from './auth';
import { db } from './db';

export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export const getCurrentUser = cache(async () => {
  const session = await getSession();
  if (!session) return null;
  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (user?.status !== 'ACTIVE') return null;
  return user;
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/** Request context for core services, built once per request. */
export const getContext = cache(async (): Promise<RequestContext> => {
  const user = await getCurrentUser();
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const locale = (await getLocale()) as 'ru' | 'en';
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
});

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

export async function requireSiteAdmin() {
  const user = await requireUser();
  if (!user.isSiteAdmin) forbidden();
  return { user, ctx: await getContext() };
}
