import { PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { createUserAction } from '@/server/actions/admin';
import { requireCapability } from '@/server/session';
import { UserForm } from '../user-form';

export default async function NewUserPage() {
  const { ctx } = await requireCapability('user:create');
  const t = await getTranslations('admin.user');
  return (
    <>
      <PageHeader title={t('new')} />
      <UserForm action={createUserAction} canSetAdmin={ctx.perm.isSiteAdmin} mode="create" />
    </>
  );
}
