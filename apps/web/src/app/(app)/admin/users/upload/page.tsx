import { listProfileFields } from '@hubium/core';
import { Alert, PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { UploadForm } from './upload-form';

export const generateMetadata = titled('admin.user', 'uploadTitle');

export default async function UploadUsersPage() {
  await requireCapability('user:create');
  const [t, tp, fields] = await Promise.all([
    getTranslations('admin.user'),
    getTranslations('profileFields'),
    listProfileFields(db),
  ]);
  return (
    <>
      <PageHeader title={t('uploadTitle')} description={t('uploadHint')} />
      {fields.length ? (
        <Alert className="mb-4">
          {tp('csvHint', { names: fields.map((f) => `profile_field_${f.shortName}`).join(', ') })}
        </Alert>
      ) : null}
      <UploadForm />
    </>
  );
}
