import { listUsers } from '@hubium/core';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { Plus, Upload, Users } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/pagination';
import { requireCapability } from '@/server/session';

export async function generateMetadata() {
  return { title: (await getTranslations('admin'))('users') };
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { ctx } = await requireCapability('user:update');
  const sp = await searchParams;
  const [t, tc, format] = await Promise.all([
    getTranslations('admin'),
    getTranslations('common'),
    getFormatter(),
  ]);
  const res = await listUsers(ctx, { q: sp.q, page: Number(sp.page) || 1 });
  const canCreate = await ctx.perm.can('user:create');
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
        <form className="flex max-w-md gap-2">
          <label htmlFor="q" className="sr-only">
            {tc('search')}
          </label>
          <Input id="q" name="q" defaultValue={sp.q} placeholder={tc('searchPlaceholder')} />
          <Button type="submit" variant="secondary">
            {tc('search')}
          </Button>
        </form>
      </search>
      {res.items.length === 0 ? (
        <EmptyState icon={<Users />} title={t('user.noUsers')} />
      ) : (
        <Table>
          <THead>
            <Tr>
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
      )}
      <Pagination page={res.page} pageSize={res.pageSize} total={res.total} params={{ q: sp.q }} />
    </>
  );
}
