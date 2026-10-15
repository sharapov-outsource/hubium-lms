import { categoryRoleHolders, roleName } from '@hubium/core';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { OverridesPanel } from '@/components/permissions/overrides-panel';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext, orRefused } from '@/server/session';
import { CategoryRoles } from './category-roles';

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
  const ctx = await getContext();
  const [holders, canAssign, locale] = await Promise.all([
    orRefused(categoryRoleHolders(ctx, id)),
    ctx.perm.can('role:assign', id),
    getLocale(),
  ]);
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
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t('categoryRoles')}</CardTitle>
          <CardDescription>{t('categoryRolesHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <CategoryRoles
            categoryId={id}
            canAssign={canAssign}
            roles={holders.map((h) => ({
              id: h.role.id,
              name: roleName(h.role, locale),
              users: h.users,
            }))}
          />
        </CardContent>
      </Card>
      <OverridesPanel contextId={id} path={`/admin/categories/${id}/permissions`} roleId={role} />
    </>
  );
}
