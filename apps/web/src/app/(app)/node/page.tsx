import { isNode, nodeConfig } from '@hubium/core/node/config';
import { isNodeAdmin } from '@hubium/core/node/nodes';
import { nodeState } from '@hubium/core/node/runtime';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@hubium/ui';
import { forbidden, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';
import { bytes } from '../admin/nodes/node-ui';
import { NodeCommands } from './node-commands';

export const generateMetadata = titled('nodes', 'thisNode');

/** The state of this local node, for the people who look after it. */
export default async function ThisNodePage() {
  // in the cloud the nodes are under Administration
  if (!isNode()) redirect('/admin/nodes');
  await requireUser();
  const ctx = await getContext();
  if (!(await isNodeAdmin(ctx, nodeConfig().id))) forbidden();
  const [t, format] = await Promise.all([getTranslations('nodes'), getFormatter()]);
  const s = nodeState();
  const when = (d: string | null) =>
    d ? format.dateTime(new Date(d), { dateStyle: 'medium', timeStyle: 'medium' }) : '—';
  const facts: [string, string][] = [
    [t('since'), when(s.since)],
    [t('offlineSince'), when(s.offlineSince)],
    [t('lag'), bytes(s.lagBytes)],
    [t('replicaB'), t(`replicaState.${s.replicaB}`)],
    [t('files'), s.files?.total ? `${s.files.done} / ${s.files.total}` : '—'],
    [t('pendingOps'), String(s.pendingOps)],
    [
      t('release'),
      s.cloudRelease && s.cloudRelease !== s.release
        ? `${s.release} ≠ ${s.cloudRelease}`
        : s.release,
    ],
    [t('lastHeartbeat'), when(s.lastHeartbeatAt)],
  ];
  return (
    <div className="grid max-w-3xl gap-6">
      <PageHeader title={t('thisNode')} description={t('thisNodeDescription')} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            {t('state')}
            <Badge
              variant={
                s.mode === 'ONLINE' ? 'success' : s.mode === 'OFFLINE' ? 'warning' : 'accent'
              }
            >
              {t(`mode.${s.mode}`)}
            </Badge>
          </CardTitle>
          <CardDescription>{t(`modeHint.${s.mode}`)}</CardDescription>
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
          <NodeCommands mode={s.mode} postponed={s.syncPostponedUntil} />
        </CardContent>
      </Card>
    </div>
  );
}
