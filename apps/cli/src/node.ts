import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';
import { AGENT_KEY_HEADER, agentKey } from '@hubium/core/node/auth';
import { releaseId } from '@hubium/core/node/config';
import type { Io } from './main.ts';
import { UsageError } from './main.ts';

/** The PostgreSQL releases the node's replicas come in (docker/node/compose.yml). */
const PG_MAJORS = [16, 17, 18];

interface Registration {
  nodeId: string;
  name: string;
  token: string;
  appSecret: string;
  appUrl: string;
  contentHost: string | null;
  release: string;
  database: {
    host: string;
    port: number;
    ca: string | null;
    role: string;
    password: string;
    slot: string;
    name: string;
    serverVersion: string | null;
    serverBuild: string | null;
    collation: { provider: string; version: string | null } | null;
  };
}

/** POST to the cloud under its own name, at `address` when given (the DNS here may differ). */
function post(hub: URL, address: string | undefined, path: string, body: unknown) {
  const secure = hub.protocol === 'https:';
  const [host, port] = (address ?? hub.host).split(':');
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = (secure ? https : http).request({
      host,
      port: Number(port || hub.port || (secure ? 443 : 80)),
      servername: hub.hostname,
      method: 'POST',
      path,
      headers: {
        host: hub.host,
        'content-type': 'application/json',
        'content-length': payload.length,
      },
      timeout: 60_000,
    });
    req.on('timeout', () => req.destroy(new Error('the cloud did not answer in 60 s')));
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 500, text: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.end(payload);
  });
}

/** A value of the .env, in single quotes (compose and Node read them literally). */
function quoted(v: string): string {
  if (v.includes("'") || v.includes('\n')) throw new Error(`a value cannot hold quotes: ${v}`);
  return `'${v}'`;
}

/** The settings of the node's .env from the cloud's answer (install-hubium.sh --node). */
export function nodeEnv(reg: Registration, address?: string): string[] {
  const db = reg.database;
  // the replica checks the certificate, not the name: the address here does for the cloud's
  const dbHost =
    address && db.host === new URL(reg.appUrl).hostname ? address.split(':')[0]! : db.host;
  const values: [string, string][] = [
    ['HUBIUM_ROLE', 'node'],
    ['HUBIUM_VERSION', reg.release.split('+')[0]!],
    ['NODE_ID', reg.nodeId],
    ['NODE_TOKEN', reg.token],
    ['NODE_HUB_URL', reg.appUrl],
    ['NODE_HUB_CONTENT_HOST', reg.contentHost ?? ''],
    ['NODE_HUB_ADDRESS', address ?? ''],
    ['APP_SECRET', reg.appSecret],
    ['NODE_DB_HOST', dbHost],
    ['NODE_DB_PORT', String(db.port)],
    ['NODE_DB_NAME', db.name],
    ['NODE_DB_ROLE', db.role],
    ['NODE_DB_PASSWORD', db.password],
    ['NODE_DB_SLOT', db.slot],
    ['NODE_PG_MAJOR', db.serverVersion?.split('.')[0] ?? ''],
    // libc collations: the replicas' C library must sort as the cloud's (install-hubium.sh)
    [
      'NODE_DB_COLLATION',
      db.collation ? `${db.collation.provider}:${db.collation.version ?? ''}` : '',
    ],
    // the certificate of the cloud's database, which the replica checks
    ['NODE_DB_CA', db.ca ? Buffer.from(db.ca).toString('base64') : ''],
  ];
  return [
    `# Local node "${reg.name.replace(/[\r\n]/g, ' ')}" of ${reg.appUrl}`,
    ...values.map(([k, v]) => `${k}=${quoted(v)}`),
  ];
}

async function register(values: Record<string, string | boolean | undefined>, io: Io) {
  const hubArg = values.hub;
  const code = values.code;
  if (typeof hubArg !== 'string' || typeof code !== 'string')
    throw new UsageError('node register needs --hub <the cloud address> and --code <code>.');
  const hub = new URL(hubArg);
  const address = typeof values.address === 'string' ? values.address : undefined;
  // the cloud refuses (and the code stays valid) when the replicas cannot copy its database
  const res = await post(hub, address, '/api/node/register', {
    code,
    release: releaseId(),
    arch: process.arch,
    pgMajors: PG_MAJORS,
  });
  if (res.status >= 400) {
    let message = res.text;
    try {
      message = (JSON.parse(res.text) as { error?: string }).error ?? res.text;
    } catch {
      // not JSON
    }
    io.err(`The cloud refused the registration (${res.status}): ${message}`);
    return 1;
  }
  const reg = JSON.parse(res.text) as Registration;
  if (!reg.database.ca)
    io.err(
      'Warning: the cloud gave no certificate of its database (NODE_REPLICATION_CA_FILE); ' +
        'the replica will not check whom it connects to.',
    );
  if (values.json) io.out(JSON.stringify(reg));
  else for (const line of nodeEnv(reg, address)) io.out(line);
  return 0;
}

/** A request to this node's agent (its control API). */
async function agent(path: string, body?: unknown) {
  const url = (process.env.NODE_AGENT_URL || 'http://127.0.0.1:3002').replace(/\/+$/, '');
  const res = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      [AGENT_KEY_HEADER]: agentKey(process.env.APP_SECRET ?? ''),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  }).catch((err: Error) => {
    throw new Error(`the node's agent at ${url} does not answer: ${err.message}`);
  });
  if (!res.ok) throw new Error(`the node's agent answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function printState(s: Record<string, unknown>, io: Io) {
  io.out(`Mode: ${s.mode} since ${s.since}`);
  if (s.offlineSince) io.out(`Without the cloud since ${s.offlineSince}`);
  if (s.syncPostponedUntil) io.out(`Sync put off until ${s.syncPostponedUntil}`);
  io.out(`Own copy (B): ${s.replicaB}`);
  if (s.lagBytes !== null) io.out(`Replica behind the cloud: ${s.lagBytes} bytes`);
  io.out(`Journal entries to send: ${s.pendingOps}`);
  const files = s.files as { done: number; total: number } | null;
  if (files) io.out(`Files: ${files.done} of ${files.total}`);
  io.out(`Release: ${s.release} (the cloud: ${s.cloudRelease ?? 'unknown'})`);
  if (s.error) io.out(`Error: ${s.error}`);
}

/**
 * `hubium node`, on a local node: `register` installs it with the code from the cloud
 * (install-hubium.sh --node runs it and writes what it prints to .env); `status`, `offline`,
 * `online` and `postpone` talk to the node's agent.
 */
export async function nodeCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      hub: { type: 'string' },
      code: { type: 'string' },
      address: { type: 'string' },
      until: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const [action = 'status'] = positionals;
  if (action === 'register') return register(values, io);
  if (action === 'status') {
    const s = await agent('/state');
    if (values.json) io.out(JSON.stringify(s));
    else printState(s, io);
    return 0;
  }
  if (action === 'offline' || action === 'online' || action === 'postpone') {
    if (action === 'postpone' && !values.until)
      throw new UsageError('node postpone needs --until <date-time>.');
    const s = await agent('/command', { action, until: values.until });
    if (values.json) io.out(JSON.stringify(s));
    else printState(s, io);
    return 0;
  }
  throw new UsageError(`Unknown action "node ${action}".`);
}
