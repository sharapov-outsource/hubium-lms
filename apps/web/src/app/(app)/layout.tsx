import { getSetting, pendingPolicies } from '@hubium/core';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { LoginAsBanner } from '@/components/shell/login-as-banner';
import type { NavItem } from '@/components/shell/nav-items';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const ctx = await getContext();
  // While logged in as someone, their own obligations (policies, password, 2FA) stay theirs.
  const loggedInAs = ctx.actor.kind === 'user' && !!ctx.actor.realUserId;
  // New mandatory policy versions must be accepted before anything else.
  if (!loggedInAs && (await pendingPolicies(db, user.id)).length) redirect('/policies');
  // A password set by an administrator must be replaced, and admins may be required to
  // use two-factor sign-in: until then only the security settings are reachable.
  const path = (await headers()).get('x-hubium-path') ?? '';
  if (!loggedInAs && path !== '/settings/security') {
    if (user.mustChangePassword) redirect('/settings/security?required=password');
    if (
      user.isSiteAdmin &&
      !user.twoFactorEnabled &&
      (await getSetting(db, 'auth.require2faForAdmins'))
    )
      redirect('/settings/security?required=2fa');
  }
  const items: NavItem[] = [
    { href: '/dashboard', label: 'nav.dashboard', icon: 'home', mobile: true },
    { href: '/my-courses', label: 'nav.myCourses', icon: 'courses', mobile: true },
    { href: '/catalog', label: 'nav.catalog', icon: 'catalog' },
    { href: '/calendar', label: 'nav.calendar', icon: 'calendar', mobile: true },
    {
      href: '/messages',
      label: 'nav.messages',
      icon: 'messages',
      mobile: true,
      liveBadge: 'messages',
    },
  ];
  if (
    user.isSiteAdmin ||
    (await ctx.perm.canAny([
      'user:update',
      'role:manage',
      'site:config',
      'category:manage',
      'cohort:manage',
    ]))
  ) {
    items.push({ href: '/admin', label: 'nav.admin', icon: 'admin', mobile: true });
  }
  return (
    <AppShell user={user} items={items}>
      {loggedInAs ? <LoginAsBanner name={user.name} /> : null}
      {children}
    </AppShell>
  );
}
