import {
  enabledLanguages,
  getAllSettings,
  isLocked,
  passwordPolicy,
  roleName,
  userRelations,
} from '@hubium/core';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { updateUserAction } from '@/server/actions/admin';
import { db } from '@/server/db';
import { viewerCan } from '@/server/page-title';
import { profileFieldViews } from '@/server/profile-fields';
import { requireCapability } from '@/server/session';
import { timezoneOptions } from '@/server/timezones';
import { UserForm } from '../user-form';
import { UserRelations } from './relations';
import { DangerZone, LockedNotice, SiteRoleToggles } from './user-actions';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id) || !(await viewerCan('user:update'))) return {};
  const user = await db.user.findUnique({ where: { id }, select: { name: true } });
  return user ? { title: user.name } : {};
}

export default async function EditUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { ctx } = await requireCapability('user:update');
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const user = await db.user.findUnique({ where: { id } });
  if (!user || user.deletedAt) notFound();
  const [t, locale, format] = await Promise.all([
    getTranslations('admin'),
    getLocale(),
    getFormatter(),
  ]);
  const roles = await db.role.findMany({
    where: { assignableLevels: { has: 'SYSTEM' } },
    orderBy: { sortOrder: 'asc' },
  });
  const assigned = await db.roleAssignment.findMany({
    where: { userId: id, contextId: SYSTEM_CONTEXT_ID },
  });
  const canAssign = await ctx.perm.can('role:assign');
  const [relations, settings] = await Promise.all([userRelations(ctx, id), getAllSettings(db)]);
  return (
    <>
      <PageHeader
        title={user.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {user.emailPlaceholder ? null : user.email}
            {user.username ? <span>@{user.username}</span> : null}
            <Badge variant={user.status === 'ACTIVE' ? 'success' : 'warning'}>
              {user.status === 'ACTIVE' ? t('user.active') : t('user.suspended')}
            </Badge>
            {isLocked(user) ? <Badge variant="warning">{t('user.locked')}</Badge> : null}
          </span>
        }
      />
      {sp.created ? (
        <Alert variant="success" className="mb-6">
          {t('user.created')}
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader>
            <CardTitle>{t('user.edit')}</CardTitle>
          </CardHeader>
          <CardContent>
            <UserForm
              action={updateUserAction}
              mode="edit"
              canSetAdmin={ctx.perm.isSiteAdmin}
              languages={await enabledLanguages(db)}
              timezones={timezoneOptions(locale)}
              passwordRules={passwordPolicy(await getAllSettings(db))}
              profileFields={await profileFieldViews(locale)}
              values={{
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.emailPlaceholder ? '' : user.email,
                locale: user.locale,
                timezone: user.timezone,
                isSiteAdmin: user.isSiteAdmin,
                customFields: user.customFields as Record<string, string | boolean>,
              }}
            />
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          {canAssign ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('user.siteRoles')}</CardTitle>
                <CardDescription>{t('user.siteRolesHint')}</CardDescription>
              </CardHeader>
              <CardContent>
                <SiteRoleToggles
                  userId={user.id}
                  roles={roles.map((r) => ({
                    id: r.id,
                    name: roleName(r, locale),
                    assigned: assigned.some((a) => a.roleId === r.id),
                  }))}
                />
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>{t('user.relations.title')}</CardTitle>
              <CardDescription>
                {settings['mentors.enabled'] ? (
                  t('user.relations.hint')
                ) : (
                  <>
                    {t('user.relations.off')}{' '}
                    <Link href="/admin/settings/general" className="text-accent hover:underline">
                      {t('siteSettings')}
                    </Link>
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <UserRelations userId={user.id} {...relations} />
              <Link
                href="/admin/users/upload-relations"
                className="text-sm text-accent hover:underline"
              >
                {t('user.relations.upload')}
              </Link>
            </CardContent>
          </Card>
          {isLocked(user) ? (
            <LockedNotice
              userId={user.id}
              until={format.dateTime(user.lockedUntil!, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            />
          ) : null}
          {user.id !== ctx.perm.userId ? (
            <DangerZone
              userId={user.id}
              name={user.name}
              suspended={user.status === 'SUSPENDED'}
              canDelete={await ctx.perm.can('user:delete')}
              canLoginAs={
                user.status === 'ACTIVE' &&
                !(ctx.actor.kind === 'user' && ctx.actor.realUserId) &&
                (!user.isSiteAdmin || ctx.perm.isSiteAdmin) &&
                (await ctx.perm.can('user:loginas'))
              }
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
