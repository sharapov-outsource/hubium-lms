import { activityRoleHolders, roleName } from '@hubium/core';
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
import { ContextRoles } from '@/components/permissions/context-roles';
import { OverridesPanel } from '@/components/permissions/overrides-panel';
import { assignActivityRoleAction, searchCourseMembersAction } from '@/server/actions/enrolment';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext, orRefused } from '@/server/session';

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
  const ctx = await getContext();
  const [holders, canAssign, locale] = await Promise.all([
    orRefused(activityRoleHolders(ctx, activityId)),
    ctx.perm.can('role:assign', activityId),
    getLocale(),
  ]);
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
      {holders.length ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t('activityRoles')}</CardTitle>
            <CardDescription>{t('activityRolesHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ContextRoles
              canAssign={canAssign}
              search={searchCourseMembersAction.bind(null, courseId)}
              assign={assignActivityRoleAction.bind(null, courseId, activityId)}
              searchLabel={t('searchParticipant')}
              roles={holders.map((h) => ({
                id: h.role.id,
                name: roleName(h.role, locale),
                users: h.users,
              }))}
            />
          </CardContent>
        </Card>
      ) : null}
      <OverridesPanel contextId={activityId} path={`${base}/permissions`} roleId={role} />
    </>
  );
}
