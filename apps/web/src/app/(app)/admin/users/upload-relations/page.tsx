import { PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { RelationsUploadForm } from './upload-form';

export const generateMetadata = titled('admin.user.relations', 'uploadTitle');

export default async function UploadRelationsPage() {
  await requireCapability('user:update');
  const t = await getTranslations('admin.user.relations');
  return (
    <>
      <PageHeader title={t('uploadTitle')} description={t('uploadHint')} />
      <pre className="mb-4 max-w-xl overflow-x-auto rounded-md bg-muted p-3 text-xs">
        {
          'mentor,mentee,kind,action\nparent@example.org,student1,parent,\nivanova,student2,mentor,remove'
        }
      </pre>
      <RelationsUploadForm />
    </>
  );
}
