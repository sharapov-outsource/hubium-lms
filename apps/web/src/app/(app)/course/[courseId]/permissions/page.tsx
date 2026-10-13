import { PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { OverridesPanel } from '@/components/permissions/overrides-panel';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('permissions', 'title');

export default async function CoursePermissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ role?: string }>;
}) {
  const [{ courseId }, { role }, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('permissions'),
  ]);
  return (
    <>
      <PageHeader title={t('title')} description={t('courseDescription')} />
      <OverridesPanel contextId={courseId} path={`/course/${courseId}/permissions`} roleId={role} />
    </>
  );
}
