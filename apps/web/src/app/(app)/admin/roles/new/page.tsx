import { PageHeader } from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { createRoleAction } from '@/server/actions/admin';
import { db } from '@/server/db';
import { requireCapability } from '@/server/session';
import { RoleForm } from '../role-form';

export default async function NewRolePage() {
  await requireCapability('role:manage');
  const [t, locale] = await Promise.all([getTranslations('admin.role'), getLocale()]);
  const roles = await db.role.findMany({ orderBy: { sortOrder: 'asc' } });
  return (
    <>
      <PageHeader title={t('new')} />
      <RoleForm
        action={createRoleAction}
        copyFrom={roles.map((r) => ({
          id: r.id,
          name: (r.name as Record<string, string>)[locale] ?? r.shortName,
        }))}
      />
    </>
  );
}
