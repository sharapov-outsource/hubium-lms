import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '@hubium/db';
import { sha256Hex } from '../crypto.ts';

// How the cloud knows a node. The node calls the node API with its token
// (`Authorization: Node <id>:<token>`); the cloud keeps only the token's hash. Requests the
// node passes on for the people in its network carry a signature made with that hash, with
// the person's address in it: the cloud then trusts that address (rate limits, the network
// rules of quizzes) and records which node the action came through.

export const NODE_SIGNATURE_HEADER = 'x-hubium-node';
/** Set by the cloud's proxy for a request a node signed; a value a client sends goes. */
export const NODE_ID_HEADER = 'x-hubium-node-id';
/** How far apart the clocks of a node and the cloud may be. */
const SKEW_SECONDS = 300;

export const tokenHash = (token: string) => sha256Hex(token);

export function nodeAuthorization(id: string, token: string): string {
  return `Node ${id}:${token}`;
}

/** The node an Authorization header names, when its token is the node's own. */
export async function authenticateNode(db: Db, authorization: string | null) {
  const m = /^Node ([0-9a-f-]{36}):(\S+)$/i.exec(authorization ?? '');
  if (!m) return null;
  const node = await db.node.findUnique({ where: { id: m[1]!.toLowerCase() } });
  if (!node?.tokenHash || node.revokedAt) return null;
  const given = Buffer.from(tokenHash(m[2]!));
  const stored = Buffer.from(node.tokenHash);
  return given.length === stored.length && timingSafeEqual(given, stored) ? node : null;
}

interface Signed {
  nodeId: string;
  method: string;
  /** Path and query of the request. */
  path: string;
  clientIp: string;
}

function mac(key: string, s: Signed & { ts: number }) {
  return createHmac('sha256', key)
    .update([s.nodeId, s.ts, s.method.toUpperCase(), s.path, s.clientIp].join('|'))
    .digest('base64url');
}

/** The signature header of a request a node passes on (key: the hash of its token). */
export function signForward(key: string, s: Signed, now = Date.now()): string {
  const ts = Math.floor(now / 1000);
  return ['v1', s.nodeId, ts, s.clientIp, mac(key, { ...s, ts })].join(';');
}

/** The parts of a signature header, before its node is looked up. */
export function parseForward(header: string | null) {
  const parts = (header ?? '').split(';');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, nodeId, ts, clientIp, sig] = parts as [string, string, string, string, string];
  if (!/^[0-9a-f-]{36}$/i.test(nodeId) || !/^\d+$/.test(ts)) return null;
  return { nodeId: nodeId.toLowerCase(), ts: Number(ts), clientIp, sig };
}

/** Whether the signature is the node's (key: its token hash) for this request, and fresh. */
export function verifyForward(
  key: string,
  parsed: NonNullable<ReturnType<typeof parseForward>>,
  req: { method: string; path: string },
  now = Date.now(),
): boolean {
  if (Math.abs(now / 1000 - parsed.ts) > SKEW_SECONDS) return false;
  const want = Buffer.from(
    mac(key, {
      nodeId: parsed.nodeId,
      ts: parsed.ts,
      method: req.method,
      path: req.path,
      clientIp: parsed.clientIp,
    }),
  );
  const given = Buffer.from(parsed.sig);
  return want.length === given.length && timingSafeEqual(want, given);
}

/**
 * What the node's web server shows the node's agent for a node admin's command (the
 * autonomous mode, the sync): the agent's control API answers only the node's own servers.
 */
export const AGENT_KEY_HEADER = 'x-hubium-agent-key';

export function agentKey(appSecret: string): string {
  return createHmac('sha256', `node-agent:${appSecret}`).update('control').digest('base64url');
}
