import { CLIENT_IP_HEADER } from '@hubium/core/client-ip';
import {
  NODE_ID_HEADER,
  NODE_SIGNATURE_HEADER,
  parseForward,
  verifyForward,
} from '@hubium/core/node/auth';
import { isNode } from '@hubium/core/node/config';
import { NODE_MODE_HEADER, noteNodeMode } from '@hubium/core/node/runtime';
import { log } from '@hubium/log';
import { db } from './db';

// Requests a local node passes on for the people in its network carry the node's signature
// (packages/core/src/node/auth.ts). The cloud's proxy checks it: the client's address in it
// is then the one the rate limits and the network rules see, and the request records the
// node it came through. A request with a signature that does not check is refused. On a node,
// the gateway's word on the mode it is in comes along.

const logger = log('web');

/** Token hashes of nodes by id, read again every half minute (revocations take effect). */
const keys = new Map<string, { key: string | null; at: number }>();

async function nodeKey(nodeId: string): Promise<string | null> {
  const hit = keys.get(nodeId);
  if (hit && Date.now() - hit.at < 30_000) return hit.key;
  const node = await db.node
    .findUnique({ where: { id: nodeId }, select: { tokenHash: true, revokedAt: true } })
    .catch(() => null);
  const key = node && !node.revokedAt ? node.tokenHash : null;
  keys.set(nodeId, { key, at: Date.now() });
  return key;
}

/**
 * The headers of the request with the node's word taken: the client's address from the
 * signature and the node's id, or a client's own claims of them removed. 'refused' for a
 * signature that does not check.
 */
export async function withNodeForward(
  req: Request,
  headers: Headers,
): Promise<Headers | 'refused'> {
  // on a node, from its gateway (which drops a client's own x-hubium-* headers)
  if (isNode()) noteNodeMode(req.headers.get(NODE_MODE_HEADER));
  headers.delete(NODE_MODE_HEADER);
  headers.delete(NODE_ID_HEADER);
  const signature = req.headers.get(NODE_SIGNATURE_HEADER);
  headers.delete(NODE_SIGNATURE_HEADER);
  if (!signature) return headers;
  const parsed = parseForward(signature);
  const url = new URL(req.url);
  const key = parsed ? await nodeKey(parsed.nodeId) : null;
  if (
    !parsed ||
    !key ||
    !verifyForward(key, parsed, { method: req.method, path: url.pathname + url.search })
  ) {
    logger.warn({ path: url.pathname }, 'request with a node signature that does not check');
    return 'refused';
  }
  headers.set(NODE_ID_HEADER, parsed.nodeId);
  if (parsed.clientIp) headers.set(CLIENT_IP_HEADER, parsed.clientIp);
  else headers.delete(CLIENT_IP_HEADER);
  return headers;
}
