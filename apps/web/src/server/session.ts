import 'server-only';
import {
  type Actor,
  anonymousAccess,
  type Capability,
  loadUserAccess,
  Permissions,
  type RequestContext,
} from '@hubium/core';
import { headers } from 'next/headers';
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
  return {
    db,
    actor,
    perm: new Permissions(db, await loadUserAccess(db, user)),
    now: new Date(),
    locale,
    ip,
    origin: 'WEB',
  };
});

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
