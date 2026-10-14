import { PageHeader } from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { profileFieldViews } from '@/server/profile-fields';
import { requireCapability } from '@/server/session';
import { SsoForm } from '../sso-form';

export const generateMetadata = titled('adminSso', 'new');

export default async function NewSsoProviderPage() {
  await requireCapability('site:config');
  const [t, fields] = await Promise.all([
    getTranslations('adminSso'),
    getLocale().then((l) => profileFieldViews(l)),
  ]);
  return (
    <>
      <PageHeader title={t('new')} />
      <SsoForm
        appUrl={process.env.APP_URL ?? 'http://localhost:3000'}
        profileFields={fields.map((f) => ({ shortName: f.shortName, label: f.label }))}
      />
    </>
  );
}
