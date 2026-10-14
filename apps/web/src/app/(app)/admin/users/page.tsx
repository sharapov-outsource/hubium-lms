import { listUsers, roleName } from '@hubium/core';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { Plus, Upload, Users } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/pagination';
import { db } from '@/server/db';
import { requireCapability } from '@/server/session';
import { BulkUsers, RowCheck } from './bulk';

export async function generateMetadata() {
  return { title: (await getTranslations('admin'))('users') };
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; status?: string }>;
}) {
  const { ctx } = await requireCapability('user:update');
  const sp = await searchParams;
  const status = sp.status === 'ACTIVE' || sp.status === 'SUSPENDED' ? sp.status : undefined;
  const [t, tc, format, locale] = await Promise.all([
    getTranslations('admin'),
    getTranslations('common'),
    getFormatter(),
    getLocale(),
  ]);
  const res = await listUsers(ctx, { q: sp.q, status, page: Number(sp.page) || 1 });
  const [canCreate, canDelete, cohorts, courses, roles] = await Promise.all([
    ctx.perm.can('user:create'),
    ctx.perm.can('user:delete'),
    db.cohort.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.course.findMany({
      where: { deletedAt: null },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true },
    }),
    db.role.findMany({
      where: { assignableLevels: { has: 'COURSE' } },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);
  return (
    <>
      <PageHeader
        title={t('users')}
        description={tc('usersCount', { count: res.total })}
        actions={
          canCreate ? (
            <>
              <Button asChild variant="secondary">
                <Link href="/admin/users/upload">
                  <Upload />
                  {t('user.upload')}
                </Link>
              </Button>
              <Button asChild>
                <Link href="/admin/users/new">
                  <Plus />
                  {t('user.new')}
                </Link>
              </Button>
            </>
          ) : null
        }
      />
      <search className="mb-4 block">
        <form className="flex max-w-xl flex-wrap gap-2">
          <label htmlFor="q" className="sr-only">
            {tc('search')}
          </label>
          <Input
            id="q"
            name="q"
            defaultValue={sp.q}
            placeholder={tc('searchPlaceholder')}
            className="min-w-48 flex-1"
          />
          <label htmlFor="status" className="sr-only">
            {tc('status')}
          </label>
          <Select id="status" name="status" defaultValue={status ?? ''} className="w-40">
            <option value="">{t('user.anyStatus')}</option>
            <option value="ACTIVE">{t('user.active')}</option>
            <option value="SUSPENDED">{t('user.suspended')}</option>
          </Select>
          <Button type="submit" variant="secondary">
            {tc('search')}
          </Button>
        </form>
      </search>
      {res.items.length === 0 ? (
        <EmptyState icon={<Users />} title={t('user.noUsers')} />
      ) : (
        <BulkUsers
          pageIds={res.items.map((u) => u.id)}
          total={res.total}
          filter={{ q: sp.q, status }}
          cohorts={cohorts}
          courses={courses.map((c) => ({ id: c.id, name: c.fullName }))}
          roles={roles.map((r) => ({ id: r.id, name: roleName(r, locale) }))}
          canDelete={canDelete}
        >
          <Table>
            <THead>
              <Tr>
                <Th className="w-10">
                  <span className="sr-only">{tc('select')}</span>
                </Th>
                <Th>{tc('name')}</Th>
                <Th>Email</Th>
                <Th>{tc('status')}</Th>
                <Th>{t('user.lastLogin')}</Th>
              </Tr>
            </THead>
            <TBody>
              {res.items.map((u) => (
                <Tr key={u.id}>
                  <Td>
                    <RowCheck id={u.id} name={u.name} />
                  </Td>
                  <Td>
                    <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                      {u.name}
                    </Link>
                    {u.isSiteAdmin ? (
                      <Badge variant="accent" className="ml-2">
                        admin
                      </Badge>
                    ) : null}
                    {u.username ? (
                      <span className="block text-xs text-muted-foreground">@{u.username}</span>
                    ) : null}
                  </Td>
                  <Td className="text-muted-foreground">{u.emailPlaceholder ? '—' : u.email}</Td>
                  <Td>
                    <Badge variant={u.status === 'ACTIVE' ? 'success' : 'warning'}>
                      {u.status === 'ACTIVE' ? t('user.active') : t('user.suspended')}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-muted-foreground">
                    {u.lastLoginAt ? format.relativeTime(u.lastLoginAt) : tc('never')}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </BulkUsers>
      )}
      <Pagination
        page={res.page}
        pageSize={res.pageSize}
        total={res.total}
        params={{ q: sp.q, status }}
      />
    </>
  );
}
