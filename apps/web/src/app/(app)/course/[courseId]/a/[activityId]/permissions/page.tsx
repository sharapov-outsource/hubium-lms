import { Button, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { OverridesPanel } from '@/components/permissions/overrides-panel';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('permissions', 'title');

export default async function ActivityPermissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; activityId: string }>;
  searchParams: Promise<{ role?: string }>;
}) {
  const [{ courseId, activityId }, { role }, t, tc] = await Promise.all([
    params,
    searchParams,
    getTranslations('permissions'),
    getTranslations('common'),
  ]);
  if (!/^[0-9a-f-]{36}$/.test(activityId)) notFound();
  const activity = await db.activity.findFirst({
    where: { id: activityId, courseId, deletedAt: null },
    select: { name: true },
  });
  if (!activity) notFound();
  const base = `/course/${courseId}/a/${activityId}`;
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('activityDescription', { name: activity.name })}
        actions={
          <Button asChild variant="outline">
            <Link href={base}>{tc('back')}</Link>
          </Button>
        }
      />
      <OverridesPanel contextId={activityId} path={`${base}/permissions`} roleId={role} />
    </>
  );
}
