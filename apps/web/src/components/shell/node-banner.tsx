import { isNode } from '@hubium/core/node/config';
import { nodeState } from '@hubium/core/node/runtime';
import { Alert } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';

/**
 * On a local node: what the people of its network can do now, while it has no connection
 * to the main server or passes on what it did without one (docs/architecture.md §1.7).
 */
export async function NodeBanner() {
  if (!isNode()) return null;
  const { mode } = nodeState();
  if (mode !== 'READONLY' && mode !== 'OFFLINE' && mode !== 'SYNC') return null;
  const t = await getTranslations('nodes.banner');
  return (
    <Alert
      variant={mode === 'SYNC' ? 'info' : 'warning'}
      role="status"
      className="mb-4"
      data-node-mode={mode}
    >
      {t(mode === 'READONLY' ? 'readonly' : mode === 'OFFLINE' ? 'offline' : 'sync')}
    </Alert>
  );
}
