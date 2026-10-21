import { flattenTree, getCategoryTree } from '@hubium/core';
import { listNodes } from '@hubium/core/node/nodes';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { NodeCreateForm } from './node-forms';
import { bytes, filesDone, NodeModeBadge } from './node-ui';

export const generateMetadata = titled('nodes', 'title');

export default async function NodesPage() {
  const { ctx } = await requireCapability('site:config');
  const [t, format, nodes, categories] = await Promise.all([
    getTranslations('nodes'),
    getFormatter(),
    listNodes(ctx),
    getCategoryTree(ctx.db, { includeHidden: true }).then(flattenTree),
  ]);
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {nodes.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('name')}</Th>
              <Th className="w-40">{t('state')}</Th>
              <Th className="w-44">{t('lastSeen')}</Th>
              <Th className="w-28">{t('lag')}</Th>
              <Th className="w-24">{t('files')}</Th>
              <Th className="w-28">{t('conflicts')}</Th>
            </Tr>
          </THead>
          <TBody>
            {nodes.map((n) => (
              <Tr key={n.id}>
                <Td>
                  <Link
                    href={`/admin/nodes/${n.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {n.name}
                  </Link>
                </Td>
                <Td>
                  <NodeModeBadge node={n} />
                </Td>
                <Td className="text-sm text-muted-foreground">
                  {n.lastSeenAt
                    ? format.dateTime(n.lastSeenAt, { dateStyle: 'medium', timeStyle: 'short' })
                    : '—'}
                </Td>
                <Td className="tabular-nums">{bytes(n.status.lagBytes)}</Td>
                <Td className="tabular-nums">{filesDone(n.status)}</Td>
                <Td className="tabular-nums">
                  {n.openConflicts ? (
                    <Link
                      href={`/admin/nodes/conflicts?node=${n.id}`}
                      className="text-accent hover:underline"
                    >
                      {n.openConflicts}
                    </Link>
                  ) : (
                    0
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      <p className="text-sm">
        <Link href="/admin/nodes/conflicts" className="text-accent hover:underline">
          {t('allConflicts')}
        </Link>
      </p>
      <Card>
        <CardHeader>
          <CardTitle>{t('new')}</CardTitle>
          <CardDescription>{t('newHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <NodeCreateForm
            categories={categories.map((c) => ({
              id: c.id,
              name: `${'— '.repeat(c.depth)}${c.name}`,
            }))}
            hub={process.env.APP_URL ?? ''}
          />
        </CardContent>
      </Card>
    </div>
  );
}
