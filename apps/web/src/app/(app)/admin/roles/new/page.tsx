import { editingLanguages, roleName } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { createRoleAction } from '@/server/actions/admin';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { RoleForm } from '../role-form';

export const generateMetadata = titled('admin.role', 'new');

export default async function NewRolePage() {
  await requireCapability('role:manage');
  const [t, locale] = await Promise.all([getTranslations('admin.role'), getLocale()]);
  const [roles, languages] = await Promise.all([
    db.role.findMany({ orderBy: { sortOrder: 'asc' } }),
    editingLanguages(db),
  ]);
  return (
    <>
      <PageHeader title={t('new')} />
      <RoleForm
        action={createRoleAction}
        languages={languages}
        copyFrom={roles.map((r) => ({ id: r.id, name: roleName(r, locale) }))}
      />
    </>
  );
}
