import { Button, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { OverridesPanel } from '@/components/permissions/overrides-panel';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('permissions', 'title');

export default async function CategoryPermissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ role?: string }>;
}) {
  const [{ id }, { role }, t, tc] = await Promise.all([
    params,
    searchParams,
    getTranslations('permissions'),
    getTranslations('common'),
  ]);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const category = await db.category.findUnique({ where: { id }, select: { name: true } });
  if (!category) notFound();
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('categoryDescription', { name: category.name })}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/categories">{tc('back')}</Link>
          </Button>
        }
      />
      <OverridesPanel contextId={id} path={`/admin/categories/${id}/permissions`} roleId={role} />
    </>
  );
}
