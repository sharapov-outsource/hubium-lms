import { getAllSettings, isModuleEnabled } from '@hubium/core';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { db } from '@/server/db';
import { sectionTitle } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';
import { AdminNav } from './admin-nav';

export async function generateMetadata() {
  return sectionTitle((await getTranslations('admin'))('title'));
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireUser();
  const ctx = await getContext();
  const [users, roles, config, categories, cohorts] = await Promise.all([
    ctx.perm.can('user:update'),
    ctx.perm.can('role:manage'),
    ctx.perm.can('site:config'),
    ctx.perm.can('category:manage'),
    ctx.perm.can('cohort:manage'),
  ]);
  if (!users && !roles && !config && !categories && !cohorts) forbidden();
  const t = await getTranslations('admin');
  const lti = isModuleEnabled(await getAllSettings(db), 'lti');
  const items = [
    { key: 'overview', href: '/admin', label: t('overview'), show: true, exact: true },
    { key: 'users', href: '/admin/users', label: t('users'), show: users },
    { key: 'categories', href: '/admin/categories', label: t('categories'), show: categories },
    { key: 'courses', href: '/admin/courses', label: t('courses'), show: categories },
    { key: 'cohorts', href: '/admin/cohorts', label: t('cohorts'), show: cohorts },
    {
      key: 'profileFields',
      href: '/admin/profile-fields',
      label: t('profileFields'),
      show: config,
    },
    { key: 'sso', href: '/admin/sso', label: t('sso'), show: config },
    { key: 'ldap', href: '/admin/ldap', label: 'LDAP', show: config },
    { key: 'roles', href: '/admin/roles', label: t('roles'), show: roles },
    { key: 'permissions', href: '/admin/permissions', label: t('permissionCheck'), show: roles },
    { key: 'grades', href: '/admin/grades', label: t('grades'), show: config },
    { key: 'modules', href: '/admin/modules', label: t('modules'), show: config },
    { key: 'lti', href: '/admin/lti', label: t('lti'), show: config && lti },
    { key: 'webhooks', href: '/admin/webhooks', label: t('webhooks'), show: config },
    { key: 'ai', href: '/admin/ai', label: t('ai'), show: config },
    { key: 'policies', href: '/admin/policies', label: t('policies'), show: config },
    { key: 'announcements', href: '/admin/announcements', label: t('announcements'), show: config },
    { key: 'languages', href: '/admin/languages', label: t('languages'), show: config },
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
