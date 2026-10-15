import { enabledLanguages, getAllSettings, passwordPolicy } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { createUserAction } from '@/server/actions/admin';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { profileFieldViews } from '@/server/profile-fields';
import { requireCapability } from '@/server/session';
import { timezoneOptions } from '@/server/timezones';
import { UserForm } from '../user-form';

export const generateMetadata = titled('admin.user', 'new');

export default async function NewUserPage() {
  const { ctx } = await requireCapability('user:create');
  const [t, fields, languages, settings] = await Promise.all([
    getTranslations('admin.user'),
    getLocale().then((l) => profileFieldViews(l)),
    enabledLanguages(db),
    getAllSettings(db),
  ]);
  return (
    <>
      <PageHeader title={t('new')} />
      <UserForm
        action={createUserAction}
        canSetAdmin={ctx.perm.isSiteAdmin}
        mode="create"
        profileFields={fields}
        languages={languages}
        timezones={timezoneOptions(await getLocale())}
        passwordRules={passwordPolicy(settings)}
      />
    </>
  );
}
