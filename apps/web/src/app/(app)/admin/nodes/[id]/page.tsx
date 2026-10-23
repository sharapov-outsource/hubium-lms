import { flattenTree, getCategoryTree } from '@hubium/core';
import { releaseId } from '@hubium/core/node/config';
import { getNode } from '@hubium/core/node/nodes';
import {
  Button,
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
import { ContextRoles } from '@/components/permissions/context-roles';
import { searchUsersAction } from '@/server/actions/mentors';
import { setNodeAdminAction } from '@/server/actions/nodes';
import { titled } from '@/server/page-title';
import { orRefused, requireCapability } from '@/server/session';
import { DeleteNodeButton, NewCodeButton, RevokeNodeButton } from '../node-buttons';
import { NodeEditForm } from '../node-forms';
import { bytes, filesDone, NodeModeBadge } from '../node-ui';

export const generateMetadata = titled('nodes', 'title');

export default async function NodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireCapability('site:config');
  const [t, tc, format, node, categories] = await Promise.all([
    getTranslations('nodes'),
    getTranslations('common'),
    getFormatter(),
    orRefused(getNode(ctx, id)),
    getCategoryTree(ctx.db, { includeHidden: true }).then(flattenTree),
  ]);
  const when = (d: Date | string | null | undefined) =>
    d ? format.dateTime(new Date(d), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const s = node.status;
  const hub = process.env.APP_URL ?? '';
  const facts: [string, string][] = [
    [t('lastSeen'), when(node.lastSeenAt)],
    [
      t('release'),
      node.version
        ? `${node.version}${node.version === releaseId() ? '' : ` ≠ ${releaseId()}`}`
        : '—',
    ],
    [t('lag'), bytes(s.lagBytes)],
    [t('replicaB'), s.replicaB ? t(`replicaState.${s.replicaB}`) : '—'],
    [t('files'), s.files?.total ? `${filesDone(s)} (${s.files.done} / ${s.files.total})` : '—'],
    [t('pendingOps'), String(s.pendingOps ?? 0)],
    [t('offlineSince'), when(s.offlineSince)],
    [t('slot'), s.slot ? t(`slotState.${s.slot}`) : '—'],
  ];
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader
        title={node.name}
        description={t('nodeDescription')}
        className="mb-0"
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/nodes">{tc('back')}</Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            {t('state')} <NodeModeBadge node={node} />
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {facts.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-border py-1">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {s.error ? <p className="text-sm text-destructive">{s.error}</p> : null}
          {node.openConflicts ? (
            <Link
              href={`/admin/nodes/conflicts?node=${node.id}`}
              className="text-sm text-accent hover:underline"
            >
              {t('openConflicts', { n: node.openConflicts })}
            </Link>
          ) : null}
        </CardContent>
      </Card>
      {!node.revokedAt ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('installation')}</CardTitle>
            <CardDescription>
              {node.installed
                ? t('installedHint')
                : t('codeExpires', { at: when(node.codeExpiresAt) })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NewCodeButton
              id={node.id}
              hub={hub}
              label={node.installed ? t('reinstall') : t('newCode')}
            />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings')}</CardTitle>
        </CardHeader>
        <CardContent>
          <NodeEditForm
            node={node}
            categories={categories.map((c) => ({
              id: c.id,
              name: `${'— '.repeat(c.depth)}${c.name}`,
            }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('admins')}</CardTitle>
          <CardDescription>{t('adminsHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ContextRoles
            canAssign={!node.revokedAt}
            search={searchUsersAction}
            assign={setNodeAdminAction.bind(null, node.id)}
            roles={[{ id: 'admin', name: t('admins'), users: node.admins }]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('outages')}</CardTitle>
          <CardDescription>{t('outagesHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {node.outages.length ? (
            <Table>
              <THead>
                <Tr>
                  <Th>{t('outageFrom')}</Th>
                  <Th>{t('outageTo')}</Th>
                  <Th className="w-24">{t('applied')}</Th>
                  <Th className="w-24">{t('conflicts')}</Th>
                  <Th>{t('synced')}</Th>
                </Tr>
              </THead>
              <TBody>
                {node.outages.map((o) => (
                  <Tr key={o.id}>
                    <Td className="text-sm">{when(o.startedAt)}</Td>
                    <Td className="text-sm">{o.endedAt ? when(o.endedAt) : t('ongoing')}</Td>
                    <Td className="tabular-nums">{o.applied}</Td>
                    <Td className="tabular-nums">{o.conflicts}</Td>
                    <Td className="text-sm">{when(o.syncedAt)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noOutages')}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{node.revokedAt ? t('deleteTitle') : t('revokeTitle')}</CardTitle>
          <CardDescription>{node.revokedAt ? t('deleteHint') : t('revokeHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {node.revokedAt ? <DeleteNodeButton id={node.id} /> : <RevokeNodeButton id={node.id} />}
        </CardContent>
      </Card>
    </div>
  );
}
