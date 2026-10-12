import { pendingPolicies } from '@hubium/core';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import type { NavItem } from '@/components/shell/nav-items';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  // New mandatory policy versions must be accepted before anything else.
  if ((await pendingPolicies(db, user.id)).length) redirect('/policies');
  const ctx = await getContext();
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
      {children}
    </AppShell>
  );
}
