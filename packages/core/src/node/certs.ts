import { readFile } from 'node:fs/promises';
import path from 'node:path';

// The cloud's certificates for its names, for nodes that answer under them (the network's
// DNS sends the cloud's names to the node). NODE_TLS_DIR holds <host>.crt and <host>.key
// for the hosts of APP_URL and CONTENT_HOST: docker/node/cloud.yml copies them there from
// the cloud's Caddy as it renews them. The node's agent fetches them and gives them to the
// node's Caddy (apps/worker/src/node/certs.ts).

export interface CertPair {
  host: string;
  cert: string;
  key: string;
}

async function pair(dir: string, host: string): Promise<CertPair | null> {
  try {
    const [cert, key] = await Promise.all([
      readFile(path.join(dir, `${host}.crt`), 'utf8'),
      readFile(path.join(dir, `${host}.key`), 'utf8'),
    ]);
    return { host, cert, key };
  } catch {
    return null;
  }
}

/** The certificates of the app's and the content's host, or null without NODE_TLS_DIR. */
export async function nodeCertificates(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ app: CertPair | null; content: CertPair | null } | null> {
  const dir = env.NODE_TLS_DIR;
  if (!dir || !env.APP_URL) return null;
  const app = new URL(env.APP_URL).hostname;
  const content = env.CONTENT_HOST ? new URL(env.CONTENT_HOST).hostname : null;
  return {
    app: await pair(dir, app),
    content: content ? await pair(dir, content) : null,
  };
}
