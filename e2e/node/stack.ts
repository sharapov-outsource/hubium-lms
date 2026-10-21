import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The cloud and two local nodes on one machine, for the node scenarios (e2e/node/*.spec.ts)
// and by hand. The databases run in Docker in the PostgreSQL image of Hubium (the nodes'
// replicas with docker/node/replica.sh); the web servers, the cloud's worker and the
// nodes' agents run as processes from the built apps (pnpm build first). Between each
// node and the cloud is a link (link.ts) the scenarios cut and restore.
//
//   node e2e/node/stack.ts up      (NODES=1 for one node)
//   node e2e/node/stack.ts down
//
// Ports: cloud web 3000, worker 3001, database 55432; node i: gateway 3i00 (what the
// browser opens), web 3i01, agent API 3i02, replica A 55i01, B 55i02, links 4i00 (HTTP)
// and 4i01 (replication) with their control on 4i99.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WORK = process.env.NODE_STACK_DIR ?? path.join(root, 'e2e/node/.stack');
const IMAGE = process.env.NODE_STACK_PG_IMAGE ?? 'pgvector/pgvector:0.8.7-pg18-bookworm';
const NET = 'hubium-nodes';
const SECRET = process.env.APP_SECRET ?? 'node-stack-secret-node-stack-secret-0000000';

export const CLOUD = {
  url: 'http://localhost:3000',
  content: 'http://127.0.0.1:3000',
  db: 'postgresql://hubium:hubium@127.0.0.1:55432/hubium',
};

export function nodePorts(i: number) {
  return {
    gateway: 3000 + i * 100,
    web: 3001 + i * 100,
    control: 3002 + i * 100,
    a: 55001 + i * 100,
    b: 55002 + i * 100,
    linkHttp: 4000 + i * 100,
    linkDb: 4001 + i * 100,
    linkControl: 4099 + i * 100,
  };
}

/** What the browser opens for node i (its own names: a pilot before the DNS change). */
export const nodeUrl = (i: number) => `http://localhost:${nodePorts(i).gateway}`;
export const nodeContent = (i: number) => `http://127.0.0.1:${nodePorts(i).gateway}`;

const sh = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  execFileSync(cmd, args, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

const quiet = (cmd: string, args: string[]) => {
  try {
    sh(cmd, args);
  } catch {
    // already gone
  }
};

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await ok()) return;
    } catch {
      // not yet
    }
    await sleep(1000);
  }
  throw new Error(`${what}: not ready after ${ms / 1000} s`);
}

const psql = (container: string, sql: string, user = 'hubium') =>
  sh('docker', ['exec', container, 'psql', '-U', user, '-d', 'hubium', '-qAtc', sql]).trim();

/** A process of the stack, its output in WORK/<name>.log and its pid in WORK/<name>.pid. */
function start(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = root) {
  const log = openSync(path.join(WORK, `${name}.log`), 'a');
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', log, log],
    detached: true,
  });
  p.unref();
  writeFileSync(path.join(WORK, `${name}.pid`), String(p.pid));
}

function stopAll() {
  if (!existsSync(WORK)) return;
  for (const f of sh('ls', [WORK])
    .split('\n')
    .filter((n) => n.endsWith('.pid'))) {
    const pid = Number(readFileSync(path.join(WORK, f), 'utf8'));
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // gone
    }
    rmSync(path.join(WORK, f));
  }
}

const containers = () =>
  sh('docker', ['ps', '-a', '--format', '{{.Names}}'])
    .split('\n')
    .filter((n) => n.startsWith('hubium-stack-'));

export async function down() {
  stopAll();
  for (const c of containers()) quiet('docker', ['rm', '-f', '-v', c]);
  quiet('docker', ['network', 'rm', NET]);
}

/** The cloud's database, ready for replication over TLS (as docker/node/cloud.sh sets it up). */
async function cloudDb() {
  const dir = path.join(WORK, 'cloud-db');
  mkdirSync(dir, { recursive: true });
  sh('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '30',
    '-subj',
    '/CN=hubium-db',
    '-keyout',
    path.join(dir, 'server.key'),
    '-out',
    path.join(dir, 'server.crt'),
  ]);
  writeFileSync(
    path.join(dir, 'pg_hba.conf'),
    readFileSync(path.join(root, 'docker/node/cloud-hba.conf')),
  );
  sh('docker', [
    'run',
    '-d',
    '--name',
    'hubium-stack-cloud',
    '--network',
    NET,
    '-p',
    '55432:5432',
    '-e',
    'POSTGRES_USER=hubium',
    '-e',
    'POSTGRES_PASSWORD=hubium',
    '-e',
    'POSTGRES_DB=hubium',
    '-v',
    `${dir}:/src:ro`,
    '-v',
    `${path.join(root, 'docker/node/cloud-db.sh')}:/cloud-db.sh:ro`,
    '--entrypoint',
    'sh',
    IMAGE,
    '/cloud-db.sh',
  ]);
  await until('cloud database', () => psql('hubium-stack-cloud', 'SELECT 1') === '1');
}

async function cloudApps() {
  const env = {
    DATABASE_URL: CLOUD.db,
    APP_URL: CLOUD.url,
    CONTENT_HOST: CLOUD.content,
    APP_SECRET: SECRET,
    STORAGE_FS_ROOT: path.join(WORK, 'cloud-storage'),
    NODE_REPLICATION_CA_FILE: path.join(WORK, 'cloud-db/server.crt'),
    AUTH_RATE_LIMIT: 'off',
    SSRF_ALLOW_HOSTS: '127.0.0.1',
    HUBIUM_WRITE_GUARD: process.env.HUBIUM_WRITE_GUARD ?? 'strict',
    NODE_FILES_MBIT: '0',
  };
  sh('pnpm', ['--filter', '@hubium/db', 'migrate:deploy'], { env });
  sh('pnpm', ['db:seed', '--profile', 'demo'], { env });
  start(
    'cloud-web',
    'pnpm',
    ['--filter', '@hubium/web', 'exec', 'next', 'start', '-p', '3000'],
    env,
  );
  start('cloud-worker', 'node', ['apps/worker/dist/main.mjs'], {
    ...env,
    WORKER_QUEUES: 'default',
  });
  await until('cloud web', async () => (await fetch(`${CLOUD.url}/api/health`)).ok, 180_000);
}

interface Registration {
  nodeId: string;
  token: string;
  appSecret: string;
  contentHost: string | null;
  database: { role: string; password: string; slot: string; ca: string | null };
}

/** Node i: its links, its databases (a copy of the cloud's), its agent and web server. */
async function node(i: number) {
  const p = nodePorts(i);
  const dir = path.join(WORK, `n${i}`);
  for (const d of ['ctl-a', 'ctl-b', 'storage']) mkdirSync(path.join(dir, d), { recursive: true });
  start(
    `n${i}-link`,
    'node',
    [
      'e2e/node/link.ts',
      `${p.linkHttp}=127.0.0.1:3000`,
      `${p.linkDb}=127.0.0.1:55432`,
      '--control',
      String(p.linkControl),
    ],
    {},
  );
  await until(`link ${i}`, async () => (await fetch(`http://127.0.0.1:${p.linkControl}/`)).ok);
  const out = sh(
    'node',
    ['apps/cli/dist/hubium.mjs', 'nodes', 'add', '--name', `Филиал ${i}`, '--json'],
    {
      env: { DATABASE_URL: CLOUD.db, APP_SECRET: SECRET },
    },
  );
  const { code } = JSON.parse(out) as { code: string };
  const res = await fetch(`http://127.0.0.1:${p.linkHttp}/api/node/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost:3000' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`registration of node ${i}: ${res.status} ${await res.text()}`);
  const reg = (await res.json()) as Registration;
  writeFileSync(path.join(dir, 'cloud-ca.crt'), reg.database.ca ?? '');
  const db = reg.database;
  // A copies the cloud through the link; B copies A
  sh('docker', [
    'run',
    '-d',
    '--name',
    `hubium-stack-n${i}-a`,
    '--network',
    NET,
    '-p',
    `${p.a}:5432`,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-v',
    `${path.join(dir, 'ctl-a')}:/control`,
    '-v',
    `${path.join(dir, 'cloud-ca.crt')}:/etc/hubium/cloud-ca.crt:ro`,
    '-v',
    `${path.join(root, 'docker/node/replica.sh')}:/replica.sh:ro`,
    '-e',
    `REPLICA_UPSTREAM=host=host.docker.internal port=${p.linkDb} user=${db.role} password=${db.password} sslmode=verify-ca sslrootcert=/etc/hubium/cloud-ca.crt`,
    '-e',
    `REPLICA_SLOT=${db.slot}`,
    '--entrypoint',
    '/replica.sh',
    IMAGE,
  ]);
  sh('docker', [
    'run',
    '-d',
    '--name',
    `hubium-stack-n${i}-b`,
    '--network',
    NET,
    '-p',
    `${p.b}:5432`,
    '-v',
    `${path.join(dir, 'ctl-b')}:/control`,
    '-v',
    `${path.join(root, 'docker/node/replica.sh')}:/replica.sh:ro`,
    '-e',
    `REPLICA_UPSTREAM=host=hubium-stack-n${i}-a port=5432 user=${db.role} password=${db.password}`,
    '-e',
    'REPLICA_SLOT=hubium_b',
    '-e',
    'REPLICA_CREATE_SLOT=yes',
    '--entrypoint',
    '/replica.sh',
    IMAGE,
  ]);
  const aUrl = `postgresql://${db.role}:${db.password}@127.0.0.1:${p.a}/hubium`;
  const bUrl = `postgresql://${db.role}:${db.password}@127.0.0.1:${p.b}/hubium`;
  await until(
    `replica A of node ${i}`,
    () => psql(`hubium-stack-n${i}-a`, 'SELECT pg_is_in_recovery()') === 't',
    180_000,
  );
  const env = {
    HUBIUM_ROLE: 'node',
    NODE_ID: reg.nodeId,
    NODE_TOKEN: reg.token,
    NODE_HUB_URL: CLOUD.url,
    NODE_HUB_CONTENT_HOST: reg.contentHost ?? '',
    NODE_HUB_ADDRESS: `127.0.0.1:${p.linkHttp}`,
    NODE_AGENT_URL: `http://127.0.0.1:${p.control}`,
    NODE_DATABASE_B_URL: bUrl,
    DATABASE_URL: aUrl,
    APP_URL: nodeUrl(i),
    CONTENT_HOST: nodeContent(i),
    APP_SECRET: reg.appSecret,
    STORAGE_DRIVER: 'mirror',
    STORAGE_FS_ROOT: path.join(dir, 'storage'),
    NODE_GATEWAY_PORT: String(p.gateway),
    NODE_CONTROL_PORT: String(p.control),
    NODE_CONTROL_HOST: '127.0.0.1',
    NODE_WEB_URL: `http://127.0.0.1:${p.web}`,
    NODE_REPLICA_A_CONTROL: path.join(dir, 'ctl-a'),
    NODE_REPLICA_B_CONTROL: path.join(dir, 'ctl-b'),
    NODE_TRUSTED_PROXY_HOPS: '0',
    NODE_OFFLINE_AFTER: process.env.NODE_OFFLINE_AFTER ?? '20',
    NODE_HEARTBEAT_MS: '2000',
    // the gateway in front of the node's web server
    TRUSTED_PROXY_HOPS: '1',
    AUTH_RATE_LIMIT: 'off',
    HUBIUM_WRITE_GUARD: process.env.HUBIUM_WRITE_GUARD ?? 'strict',
    WORKER_HEALTH_PORT: String(p.control + 50),
  };
  writeFileSync(path.join(dir, 'node.json'), JSON.stringify({ ...reg, env }, null, 2));
  start(`n${i}-agent`, 'node', ['apps/worker/dist/main.mjs'], env);
  start(
    `n${i}-web`,
    'pnpm',
    ['--filter', '@hubium/web', 'exec', 'next', 'start', '-p', String(p.web)],
    env,
  );
  await until(
    `node ${i}`,
    async () => {
      const s = (await (await fetch(`http://127.0.0.1:${p.control}/state`)).json()) as {
        mode: string;
      };
      return s.mode === 'ONLINE' && (await fetch(`${nodeUrl(i)}/api/health`)).ok;
    },
    180_000,
  );
}

export async function up(nodes = Number(process.env.NODES ?? 2)) {
  await down();
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  sh('docker', ['network', 'create', NET]);
  await cloudDb();
  await cloudApps();
  for (let i = 1; i <= nodes; i++) await node(i);
}

/**
 * The link of node i: cut ('down' stalls, 'refuse' resets), restored ('up'), or losing the
 * answer to the next sync batch ('lose-replay'). Answers how many such answers were lost.
 */
export async function link(i: number, state: 'up' | 'down' | 'refuse' | 'lose-replay') {
  const res = await fetch(`http://127.0.0.1:${nodePorts(i).linkControl}/${state}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`link ${i}: ${res.status}`);
  return Number(/lost-replays=(\d+)/.exec(await res.text())?.[1] ?? 0);
}

/** The state of node i's agent. */
export async function nodeState(i: number): Promise<{ mode: string; [k: string]: unknown }> {
  return (await fetch(`http://127.0.0.1:${nodePorts(i).control}/state`)).json() as never;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const what = process.argv[2];
  if (what === 'up') await up();
  else if (what === 'down') await down();
  else {
    console.error('node e2e/node/stack.ts up|down');
    process.exit(1);
  }
  console.log(`stack ${what}`);
}
