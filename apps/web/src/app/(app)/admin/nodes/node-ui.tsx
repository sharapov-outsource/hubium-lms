import type { NodeStatus } from '@hubium/core/node/nodes';
import { Badge } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';

/** A node's mode as a badge: installed or not, revoked, silent, or what it said last. */
export async function NodeModeBadge({
  node,
}: {
  node: { mode: string; installed: boolean; revokedAt: Date | null; lastSeenAt: Date | null };
}) {
  const t = await getTranslations('nodes');
  if (node.revokedAt) return <Badge variant="destructive">{t('mode.revoked')}</Badge>;
  if (!node.installed) return <Badge variant="neutral">{t('mode.notInstalled')}</Badge>;
  // a node the cloud has not heard for a while has no connection, whatever it said last
  const silent = !node.lastSeenAt || Date.now() - node.lastSeenAt.getTime() > 60_000;
  if (silent) return <Badge variant="warning">{t('mode.silent')}</Badge>;
  const variant =
    node.mode === 'ONLINE' ? 'success' : node.mode === 'OFFLINE' ? 'warning' : 'accent';
  return <Badge variant={variant}>{t(`mode.${node.mode}`)}</Badge>;
}

/** Bytes as people read them. */
export function bytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Files copied of all, as a share. */
export function filesDone(s: NodeStatus): string {
  if (!s.files?.total) return '—';
  return `${Math.floor((s.files.done / s.files.total) * 100)}%`;
}
