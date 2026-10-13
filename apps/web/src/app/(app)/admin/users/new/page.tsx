import { PageHeader } from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { createUserAction } from '@/server/actions/admin';
import { titled } from '@/server/page-title';
import { profileFieldViews } from '@/server/profile-fields';
import { requireCapability } from '@/server/session';
import { UserForm } from '../user-form';

export const generateMetadata = titled('admin.user', 'new');

export default async function NewUserPage() {
  const { ctx } = await requireCapability('user:create');
  const [t, fields] = await Promise.all([
    getTranslations('admin.user'),
    getLocale().then((l) => profileFieldViews(l)),
  ]);
  return (
    <>
      <PageHeader title={t('new')} />
      <UserForm
        action={createUserAction}
        canSetAdmin={ctx.perm.isSiteAdmin}
        mode="create"
        profileFields={fields}
      />
    </>
  );
}
