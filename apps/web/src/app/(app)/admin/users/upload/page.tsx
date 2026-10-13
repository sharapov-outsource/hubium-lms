import { PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { UploadForm } from './upload-form';

export const generateMetadata = titled('admin.user', 'uploadTitle');

export default async function UploadUsersPage() {
  await requireCapability('user:create');
  const t = await getTranslations('admin.user');
  return (
    <>
      <PageHeader title={t('uploadTitle')} description={t('uploadHint')} />
      <UploadForm />
    </>
  );
}
