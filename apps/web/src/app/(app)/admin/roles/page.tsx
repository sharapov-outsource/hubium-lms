import { Badge, Button, PageHeader, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { requireCapability } from '@/server/session';

export default async function RolesPage() {
  await requireCapability('role:manage');
  const [t, tc, locale] = await Promise.all([
    getTranslations('admin'),
    getTranslations('common'),
    getLocale(),
  ]);
  const roles = await db.role.findMany({
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { assignments: true, capabilities: true } } },
  });
  return (
    <>
      <PageHeader
        title={t('roles')}
        actions={
          <Button asChild>
            <Link href="/admin/roles/new">
              <Plus />
              {t('role.new')}
            </Link>
          </Button>
        }
      />
      <Table>
        <THead>
          <Tr>
            <Th>{tc('name')}</Th>
            <Th>{t('role.shortName')}</Th>
            <Th>{t('role.archetype')}</Th>
            <Th className="text-right">{t('role.capabilities')}</Th>
            <Th className="text-right">{t('users')}</Th>
          </Tr>
        </THead>
        <TBody>
          {roles.map((r) => (
            <Tr key={r.id}>
              <Td>
                <Link href={`/admin/roles/${r.id}`} className="font-medium hover:underline">
                  {(r.name as Record<string, string>)[locale] ?? r.shortName}
                </Link>
                {r.isProtected ? <Badge className="ml-2">{t('role.protected')}</Badge> : null}
              </Td>
              <Td className="font-mono text-xs">{r.shortName}</Td>
              <Td>{t(`role.archetypes.${r.archetype}`)}</Td>
              <Td className="text-right tabular-nums">{r._count.capabilities}</Td>
              <Td className="text-right tabular-nums">{r._count.assignments}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </>
  );
}
