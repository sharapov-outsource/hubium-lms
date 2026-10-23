import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CertPair } from '@hubium/core/node/certs';
import { log } from '@hubium/log';
import { CloudError, cloudCall } from './cloud.ts';
import type { AgentSettings } from './settings.ts';

// The cloud's certificates for the node's Caddy, when the node answers under the cloud's
// names (docker/node/Caddyfile, NODE_TLS=cloud): fetched from the cloud, written to
// NODE_TLS_DIR as app.crt/app.key and content.crt/content.key, and loaded by Caddy through
// its admin API when they change. The node keeps the last ones while the cloud is away.

const logger = log('node-certs');

async function same(file: string, text: string) {
  return (await readFile(file, 'utf8').catch(() => null)) === text;
}

/** Writes `text` to `file` whole (through a temporary file), readable by its owner only. */
async function put(file: string, text: string) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

async function reloadCaddy(s: AgentSettings) {
  const caddyfile = await readFile(s.caddyfile, 'utf8');
  const res = await fetch(`${s.caddyAdmin}/load`, {
    method: 'POST',
    headers: { 'content-type': 'text/caddyfile' },
    body: caddyfile,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(`Caddy did not load its configuration: ${res.status} ${await res.text()}`);
}

/** Fetches the certificates; true when new ones were loaded. */
export async function refreshCertificates(s: AgentSettings): Promise<boolean> {
  if (!s.tlsDir) return false;
  let certs: { app: CertPair | null; content: CertPair | null };
  try {
    certs = await cloudCall(s, 'GET', 'cert');
  } catch (err) {
    if (err instanceof CloudError && err.status === 404) {
      logger.warn('the cloud hands out no certificates (NODE_TLS_DIR in the cloud)');
      return false;
    }
    throw err;
  }
  await mkdir(s.tlsDir, { recursive: true });
  let changed = false;
  for (const [name, pair] of [
    ['app', certs.app],
    ['content', certs.content ?? certs.app],
  ] as const) {
    if (!pair) continue;
    const crt = path.join(s.tlsDir, `${name}.crt`);
    const key = path.join(s.tlsDir, `${name}.key`);
    if ((await same(crt, pair.cert)) && (await same(key, pair.key))) continue;
    await put(key, pair.key);
    await put(crt, pair.cert);
    changed = true;
  }
  if (!changed) return false;
  logger.info('new certificates from the cloud');
  await reloadCaddy(s).catch((err) =>
    logger.warn({ err }, 'Caddy did not take the new certificates (it reads them when it starts)'),
  );
  return true;
}
