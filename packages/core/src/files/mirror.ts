import { log } from '@hubium/log';
import { nodeConfig } from '../node/config.ts';

// How a local node's storage (MirrorStorage in storage.ts) gets a file it lacks: the
// node's agent fetches it from the cloud onto the shared disk. The web server asks the
// agent; the agent fetches it itself (setMirrorFetcher).

const logger = log('files');

type Fetcher = (key: string) => Promise<boolean>;

const shared = globalThis as unknown as { hubiumMirrorFetcher?: Fetcher };

/** In the agent: how it fetches a file from the cloud. */
export function setMirrorFetcher(fn: Fetcher): void {
  shared.hubiumMirrorFetcher = fn;
}

export async function fetchFromCloud(key: string): Promise<boolean> {
  if (shared.hubiumMirrorFetcher) return shared.hubiumMirrorFetcher(key);
  try {
    const res = await fetch(`${nodeConfig().agentUrl}/fetch-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(120_000),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err, key }, 'the node agent did not fetch a file');
    return false;
  }
}
