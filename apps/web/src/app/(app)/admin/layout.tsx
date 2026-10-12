import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getContext, requireUser } from '@/server/session';
import { AdminNav } from './admin-nav';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireUser();
  const ctx = await getContext();
  const [users, roles, config] = await Promise.all([
    ctx.perm.can('user:update'),
    ctx.perm.can('role:manage'),
    ctx.perm.can('site:config'),
  ]);
  if (!users && !roles && !config) forbidden();
  const t = await getTranslations('admin');
  const items = [
    { key: 'overview', href: '/admin', label: t('overview'), show: true, exact: true },
    { key: 'users', href: '/admin/users', label: t('users'), show: users },
    { key: 'roles', href: '/admin/roles', label: t('roles'), show: roles },
    { key: 'permissions', href: '/admin/permissions', label: t('permissionCheck'), show: roles },
    { key: 'settings', href: '/admin/settings/general', label: t('siteSettings'), show: config },
    { key: 'environment', href: '/admin/environment', label: t('environment'), show: config },
  ].filter((i) => i.show);
  return (
    <div>
      <AdminNav label={t('title')} items={items} />
      {children}
    </div>
  );
}
