import { getCourseAccess, listParticipants } from '@hubium/core';
import { Avatar, Badge, Button, Input, Select, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/pagination';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { EnrolDialog, ParticipantActions } from './participant-actions';

export const generateMetadata = titled('course', 'tabs.participants');

export default async function ParticipantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ q?: string; role?: string; group?: string; page?: string }>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canViewParticipants) forbidden();
  const [t, tc, locale, format] = await Promise.all([
    getTranslations('participants'),
    getTranslations('common'),
    getLocale(),
    getFormatter(),
  ]);
  const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/.test(v) ? v : undefined);
  const res = await listParticipants(ctx, {
    courseId,
    q: sp.q,
    roleId: uuid(sp.role),
    groupId: uuid(sp.group),
    page: Number(sp.page) || 1,
  });
  const [roles, groups] = await Promise.all([
    db.role.findMany({
      where: { assignableLevels: { has: 'COURSE' } },
      orderBy: { sortOrder: 'asc' },
    }),
    db.group.findMany({ where: { courseId }, orderBy: { name: 'asc' } }),
  ]);
  const roleName = (r: { name: unknown; shortName: string }) =>
    (r.name as Record<string, string>)[locale] ?? r.shortName;
  const canManage = access.canManageEnrolments;
  const canRoles = await ctx.perm.can('role:assign', courseId);
  const now = new Date();
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <search className="block">
          <form className="flex flex-wrap items-end gap-2">
            <label htmlFor="pq" className="sr-only">
              {tc('search')}
            </label>
            <Input
              id="pq"
              name="q"
              defaultValue={sp.q}
              placeholder={tc('searchPlaceholder')}
              className="w-56"
            />
            <Select
              name="role"
              defaultValue={sp.role ?? ''}
              aria-label={t('role')}
              className="w-44"
            >
              <option value="">{t('allRoles')}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleName(r)}
                </option>
              ))}
            </Select>
            {groups.length ? (
              <Select
                name="group"
                defaultValue={sp.group ?? ''}
                aria-label={t('groups')}
                className="w-44"
              >
                <option value="">{t('allGroups')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button type="submit" variant="secondary">
              {tc('apply')}
            </Button>
          </form>
        </search>
        {canManage ? (
          <EnrolDialog
            courseId={courseId}
            roles={roles.map((r) => ({ id: r.id, name: roleName(r), shortName: r.shortName }))}
          />
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t('enrolledN', { count: res.total })}</p>
      <Table>
        <THead>
          <Tr>
            <Th>{tc('name')}</Th>
            <Th>{t('roles')}</Th>
            <Th>{t('groups')}</Th>
            <Th>{t('status')}</Th>
            <Th>{t('lastAccess')}</Th>
            {canManage ? <Th className="text-right">{tc('actions')}</Th> : null}
          </Tr>
        </THead>
        <TBody>
          {res.users.map((u) => {
            const e = u.enrolments[0];
            const current =
              e &&
              e.status === 'ACTIVE' &&
              (!e.endsAt || e.endsAt > now) &&
              (!e.startsAt || e.startsAt <= now);
            return (
              <Tr key={u.id}>
                <Td>
                  <div className="flex items-center gap-2">
                    <Avatar name={u.name} src={u.image} size={28} />
                    <div>
                      <a href={`/profile/${u.id}`} className="font-medium hover:underline">
                        {u.name}
                      </a>
                      {canManage && !u.emailPlaceholder ? (
                        <p className="text-xs text-muted-foreground">{u.email}</p>
                      ) : null}
                    </div>
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {u.roleAssignments.map((ra) => (
                      <Badge key={ra.id} variant="accent">
                        {roleName(ra.role)}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td className="text-sm">
                  {u.groupMembers.map((g) => g.group.name).join(', ') || (
                    <span className="text-muted-foreground">{t('noGroup')}</span>
                  )}
                </Td>
                <Td>
                  <Badge variant={current ? 'success' : 'warning'}>
                    {e?.status === 'SUSPENDED'
                      ? t('suspended')
                      : current
                        ? t('active')
                        : t('notCurrent')}
                  </Badge>
                  {e?.endsAt ? (
                    <p className="text-xs text-muted-foreground">
                      {t('endsAt')}: {format.dateTime(e.endsAt, { dateStyle: 'medium' })}
                    </p>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap text-sm text-muted-foreground">
                  {u.courseAccesses[0]
                    ? format.relativeTime(u.courseAccesses[0].lastAccessAt)
                    : tc('never')}
                </Td>
                {canManage ? (
                  <Td className="text-right">
                    <ParticipantActions
                      courseId={courseId}
                      user={{ id: u.id, name: u.name, suspended: e?.status === 'SUSPENDED' }}
                      roles={canRoles ? roles.map((r) => ({ id: r.id, name: roleName(r) })) : []}
                      current={u.roleAssignments.map((ra) => ra.roleId)}
                    />
                  </Td>
                ) : null}
              </Tr>
            );
          })}
        </TBody>
      </Table>
      <Pagination
        page={res.page}
        pageSize={res.pageSize}
        total={res.total}
        params={{ q: sp.q, role: sp.role, group: sp.group }}
      />
    </div>
  );
}
