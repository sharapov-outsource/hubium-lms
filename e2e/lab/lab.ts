import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The lab of a cloud and branch servers, installed as in production (docs/PLAN.md, "Стенд
// «облако + филиал»"): each server is a container of Ubuntu with Docker inside
// (server/Dockerfile) on a network that stands for the internet. The cloud is installed with
// install-hubium.sh in Docker with the demo courses and enable-nodes; a branch gets its node
// with install-hubium.sh --node and a code from the cloud. The images are built from the
// sources and handed to the servers, which have no internet.
//
//   node e2e/lab/lab.ts build    the images (LAB_REBUILD=1 builds the app's image again)
//   node e2e/lab/lab.ts up       the cloud, installed (the lab scenarios add the branches)
//   node e2e/lab/lab.ts down
//
// The cloud answers as https://lms.test and https://content.test with certificates of its
// Caddy's own authority (local_certs): the nodes get it with --hub-ca, the browser of the
// scenarios maps the names to a branch server, as the DNS of a branch would.
//
// In a sandbox whose HTTPS goes through a proxy with its own authority, LAB_BUILD_CA names
// that authority's certificate: the build stages trust it (it does not reach the images).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WORK = process.env.LAB_DIR ?? path.join(root, 'e2e/lab/.lab');
const RELEASE = path.join(WORK, 'release');
const NET = 'hubium-lab';
const SUBNET = '10.231.77.0/24';
export const CLOUD_IP = '10.231.77.10';
export const branchIp = (i: number) => `10.231.77.${20 + i}`;
export const DOMAIN = 'lms.test';
export const CONTENT_DOMAIN = 'content.test';
export const LMS = `https://${DOMAIN}`;
export const ADMIN = { login: 'admin@hubium.local', password: 'Admin12345!' };

// the image is tagged with the release's version, as a published release is: a node runs the
// version the cloud reports when it registers
const VERSION = (
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
).version;
export const APP_IMAGE = `ghcr.io/sharapov-outsource/hubium-lms:${VERSION}`;
export const UPGRADE_VERSION = `${VERSION}-upgrade`;
export const UPGRADE_IMAGE = `ghcr.io/sharapov-outsource/hubium-lms:${UPGRADE_VERSION}`;
const SERVER_IMAGE = 'hubium-lab-server';
const PG_IMAGE = 'pgvector/pgvector:0.8.7-pg18-bookworm';
const CADDY_IMAGE = 'caddy:2.11';
const MAILPIT_IMAGE = 'axllent/mailpit:v1.31';
const CLOUD_IMAGES = [APP_IMAGE, PG_IMAGE, CADDY_IMAGE, MAILPIT_IMAGE];
const NODE_IMAGES = [APP_IMAGE, PG_IMAGE, CADDY_IMAGE];
const MODULES = 'assign,quiz,forum,scorm,h5p,lti';

export const cloudServer = 'lab-cloud';
export const branchServer = (i: number) => `lab-branch${i}`;

const sh = (cmd: string, args: string[], input?: string) =>
  execFileSync(cmd, args, {
    cwd: root,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).toString();

const quiet = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status;

/** A command with its output in WORK/<log>.log (installations take minutes). */
function logged(log: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, `${log}.log`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(file, `$ ${cmd} ${args.join(' ')}\n${out}\n`, { flag: 'a' });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed (${file}):\n${out.slice(-3000)}`);
  return out;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await ok()) return;
    } catch {
      // not yet
    }
    await sleep(2000);
  }
  throw new Error(`${what}: not ready after ${ms / 1000} s`);
}

const imageExists = (image: string) => quiet('docker', ['image', 'inspect', image]) === 0;

/** Build arguments that let a sandbox's proxy through (LAB_BUILD_CA). */
function proxyArgs(): string[] {
  if (!process.env.LAB_BUILD_CA) return [];
  const args = ['--network', 'host'];
  for (const k of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ])
    if (process.env[k]) args.push('--build-arg', k);
  return args;
}

/** The app's image (docker/Dockerfile, target hubium) of the sources in `context`. */
function buildApp(context: string, tag: string) {
  const commit = sh('git', ['rev-parse', 'HEAD']).trim();
  let dockerfile = path.join(context, 'docker/Dockerfile');
  const extra: string[] = [];
  if (process.env.LAB_BUILD_CA) {
    // the build stages trust the proxy's authority; the final stages start afresh
    dockerfile = path.join(WORK, 'Dockerfile');
    writeFileSync(
      dockerfile,
      readFileSync(path.join(root, 'docker/Dockerfile'), 'utf8').replace(
        /^(FROM node:\$\{NODE_VERSION\} AS base)$/m,
        '$1\nCOPY --from=labca ca.crt /usr/local/share/lab-ca.crt\n' +
          'ENV NODE_EXTRA_CA_CERTS=/usr/local/share/lab-ca.crt NPM_CONFIG_CAFILE=/usr/local/share/lab-ca.crt',
      ),
    );
    const ca = path.join(WORK, 'build-ca');
    mkdirSync(ca, { recursive: true });
    writeFileSync(path.join(ca, 'ca.crt'), readFileSync(process.env.LAB_BUILD_CA));
    extra.push('--build-context', `labca=${ca}`);
  }
  logged('build', 'docker', [
    'buildx',
    'build',
    ...proxyArgs(),
    ...extra,
    '--build-arg',
    `BUILD_COMMIT=${commit}`,
    '--target',
    'hubium',
    '-t',
    tag,
    '-f',
    dockerfile,
    '--load',
    context,
  ]);
}

/**
 * The next release of the app, for the cloud's upgrade during an outage: the same sources
 * (as they are here) with another version.
 */
function buildUpgrade() {
  const src = path.join(WORK, 'upgrade-src');
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  logged('build', 'sh', [
    '-c',
    `git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - | tar -xf - -C ${src}`,
  ]);
  const pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8')) as {
    version: string;
  };
  pkg.version = UPGRADE_VERSION;
  writeFileSync(path.join(src, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  buildApp(src, UPGRADE_IMAGE);
  rmSync(src, { recursive: true, force: true });
}

/** The images: the app's (LAB_REBUILD=1 builds it again), its next release, the servers'. */
export function build() {
  mkdirSync(WORK, { recursive: true });
  if (process.env.LAB_REBUILD || !imageExists(APP_IMAGE)) buildApp(root, APP_IMAGE);
  if (process.env.LAB_REBUILD || !imageExists(UPGRADE_IMAGE)) buildUpgrade();
  logged('build', 'docker', [
    'buildx',
    'build',
    ...proxyArgs(),
    '-t',
    SERVER_IMAGE,
    '--load',
    'e2e/lab/server',
  ]);
  for (const image of [PG_IMAGE, CADDY_IMAGE, MAILPIT_IMAGE])
    if (!imageExists(image)) logged('build', 'docker', ['pull', '-q', image]);
  release();
}

/** What install-hubium.sh --from-dir takes: compose.yml, Caddyfile, node.tar.gz. */
function release() {
  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(RELEASE, { recursive: true });
  writeFileSync(
    path.join(RELEASE, 'compose.yml'),
    readFileSync(path.join(root, 'docker/compose.yml')),
  );
  // a network without the internet: Caddy's own authority signs the cloud's certificates
  writeFileSync(
    path.join(RELEASE, 'Caddyfile'),
    `{\n\tlocal_certs\n}\n\n${readFileSync(path.join(root, 'docker/Caddyfile'), 'utf8')}`,
  );
  logged('build', 'sh', ['scripts/node-files.sh', RELEASE]);
  // checksums, as a release has them: the installer verifies what it takes
  writeFileSync(
    path.join(RELEASE, 'SHA256SUMS'),
    ['compose.yml', 'Caddyfile', 'node.tar.gz']
      .map(
        (f) =>
          `${createHash('sha256')
            .update(readFileSync(path.join(RELEASE, f)))
            .digest('hex')}  ${f}\n`,
      )
      .join(''),
  );
  writeFileSync(
    path.join(RELEASE, 'install-hubium.sh'),
    readFileSync(path.join(root, 'install-hubium.sh')),
  );
}

/** A command on a server (`docker exec`), its output. */
export function onServer(server: string, cmd: string[], input?: string) {
  return sh('docker', ['exec', ...(input === undefined ? [] : ['-i']), server, ...cmd], input);
}

/** A server: started, its Docker up, the images and the release on it. */
async function startServer(server: string, ip: string, images: string[]) {
  quiet('docker', ['rm', '-fv', server]);
  sh('docker', [
    'run',
    '-d',
    '--privileged',
    '--name',
    server,
    '--hostname',
    server,
    '--network',
    NET,
    '--ip',
    ip,
    SERVER_IMAGE,
  ]);
  await serverDocker(server);
  logged(server, 'sh', [
    '-c',
    `docker save ${images.join(' ')} | docker exec -i ${server} docker load`,
  ]);
  sh('docker', ['exec', server, 'mkdir', '-p', '/lab']);
  sh('docker', ['cp', RELEASE, `${server}:/lab/release`]);
}

/** More images for a server (the next release, when a scenario upgrades). */
export function loadImages(server: string, images: string[]) {
  logged(server, 'sh', [
    '-c',
    `docker save ${images.join(' ')} | docker exec -i ${server} docker load`,
  ]);
}

async function serverDocker(server: string) {
  await until(
    `${server}: Docker`,
    () => quiet('docker', ['exec', server, 'docker', 'info']) === 0,
    120_000,
  );
}

/** install-hubium.sh on a server, with its output in WORK/<server>.log. */
export function installer(server: string, args: string[]) {
  return logged(server, 'docker', [
    'exec',
    server,
    'bash',
    '/lab/release/install-hubium.sh',
    '--yes',
    '--from-dir',
    '/lab/release',
    '--version',
    VERSION,
    '--no-pull',
    ...args,
  ]);
}

/** docker compose of the cloud's installation (/opt/hubium) on its server. */
export function cloudCompose(args: string[], input?: string) {
  return onServer(
    cloudServer,
    [
      'docker',
      'compose',
      '--project-directory',
      '/opt/hubium',
      '-f',
      '/opt/hubium/compose.yml',
      '-f',
      '/opt/hubium/node/cloud.yml',
      '--env-file',
      '/opt/hubium/.env',
      ...args,
    ],
    input,
  );
}

/** docker compose of branch i's node (/opt/hubium/node) on its server. */
export function nodeCompose(i: number, args: string[], input?: string) {
  return onServer(
    branchServer(i),
    [
      'docker',
      'compose',
      '--project-directory',
      '/opt/hubium/node',
      '-f',
      '/opt/hubium/node/compose.yml',
      '--env-file',
      '/opt/hubium/node/.env',
      ...args,
    ],
    input,
  );
}

interface LabState {
  cloudDb: string;
  hubCa: string;
}

export function labState(): LabState {
  return JSON.parse(readFileSync(path.join(WORK, 'lab.json'), 'utf8')) as LabState;
}

/** The cloud server with Hubium installed (Docker, demo courses) and ready for nodes. */
export async function up() {
  await down();
  mkdirSync(WORK, { recursive: true });
  for (const f of ['lab-cloud.log', 'lab-branch1.log', 'lab-branch2.log'])
    rmSync(path.join(WORK, f), { force: true });
  sh('docker', ['network', 'create', '--subnet', SUBNET, NET]);
  await startServer(cloudServer, CLOUD_IP, CLOUD_IMAGES);
  installer(cloudServer, [
    '--mode',
    'docker',
    '--domain',
    DOMAIN,
    '--content-domain',
    CONTENT_DOMAIN,
    '--https',
    'caddy',
    '--db',
    'bundled',
    '--storage',
    'fs',
    '--modules',
    MODULES,
    '--demo',
    'yes',
    '--admin-email',
    ADMIN.login,
    '--admin-password',
    ADMIN.password,
  ]);
  installer(cloudServer, ['enable-nodes', '--replication-host', CLOUD_IP]);
  await until(
    'the cloud over HTTPS',
    () =>
      quiet('docker', [
        'exec',
        cloudServer,
        'curl',
        '-fsk',
        '--resolve',
        `${DOMAIN}:443:127.0.0.1`,
        `${LMS}/api/health`,
      ]) === 0,
    180_000,
  );
  const hubCa = path.join(WORK, 'hub-ca.crt');
  await until('the cloud certificate authority', () => {
    writeFileSync(
      hubCa,
      cloudCompose(['exec', '-T', 'caddy', 'cat', '/data/caddy/pki/authorities/local/root.crt']),
    );
    return readFileSync(hubCa, 'utf8').includes('BEGIN CERTIFICATE');
  });
  const password = /^POSTGRES_PASSWORD='?([^'\n]*)'?$/m.exec(
    onServer(cloudServer, ['cat', '/opt/hubium/.env']),
  )?.[1];
  if (!password) throw new Error('POSTGRES_PASSWORD is missing in the cloud .env');
  const state: LabState = {
    cloudDb: `postgresql://hubium:${encodeURIComponent(password)}@${CLOUD_IP}:5432/hubium`,
    hubCa,
  };
  writeFileSync(path.join(WORK, 'lab.json'), JSON.stringify(state, null, 2));
  return state;
}

/** A branch server, with Docker and the images, nothing installed yet. */
export async function startBranch(i: number) {
  await startServer(branchServer(i), branchIp(i), NODE_IMAGES);
  sh('docker', ['cp', labState().hubCa, `${branchServer(i)}:/lab/hub-ca.crt`]);
}

/**
 * install-hubium.sh --node on branch i: the cloud's names (its DNS sends them to the node),
 * the cloud reached at its address, its authority trusted.
 */
export function installNode(i: number, code: string, extra: string[] = []) {
  return installer(branchServer(i), [
    '--node',
    '--hub',
    LMS,
    '--code',
    code,
    '--hub-address',
    CLOUD_IP,
    '--hub-ca',
    '/lab/hub-ca.crt',
    ...extra,
  ]);
}

/** `hubium node …` on branch i (its agent), the output. */
export function nodeCommand(i: number, args: string[]) {
  return nodeCompose(i, ['exec', '-T', 'agent', 'hubium', 'node', ...args]);
}

export interface NodeStatus {
  mode: string;
  release?: string;
  cloudRelease?: string;
  replicaA?: string;
  replicaB?: string;
  journal?: { pending?: number };
  [k: string]: unknown;
}

export function nodeStatus(i: number): NodeStatus {
  return JSON.parse(nodeCommand(i, ['status', '--json'])) as NodeStatus;
}

const agentIps = new Map<number, string>();

/**
 * The agent's own state (its control API, from the branch's server): quicker than `hubium
 * node status`, for catching a mode that lasts a moment (SYNC).
 */
export function agentState(i: number): NodeStatus {
  let ip = agentIps.get(i);
  if (!ip) {
    ip = onServer(branchServer(i), [
      'docker',
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      'hubium-node-agent-1',
    ]).trim();
    agentIps.set(i, ip);
  }
  try {
    return JSON.parse(
      onServer(branchServer(i), ['curl', '-fsS', '--max-time', '2', `http://${ip}:3002/state`]),
    ) as NodeStatus;
  } catch (err) {
    // the agent restarted with another address
    agentIps.delete(i);
    throw err;
  }
}

/** Polls the agent quickly until it is in a mode (for acting while the mode lasts). */
export async function whenMode(i: number, mode: string, ms = 300_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (agentState(i).mode === mode) return;
    } catch {
      // restarting
    }
    await sleep(100);
  }
  throw new Error(`branch ${i} never in mode ${mode} within ${ms / 1000} s`);
}

export async function waitForMode(i: number, mode: string, ms = 180_000) {
  let last = '?';
  await until(
    `branch ${i} in mode ${mode} (last ${last})`,
    () => {
      last = nodeStatus(i).mode;
      return last === mode;
    },
    ms,
  );
}

export type LinkState = 'up' | 'down' | 'refuse' | 'slow';
const links = new Map<number, LinkState>();

/**
 * The line between branch i and the cloud, on the branch's server: 'down' drops the packets
 * (a cut line: connections hang), 'refuse' resets them, 'slow' adds delay and loss (tc netem),
 * 'up' restores it. The branch's own network (the browser) is not touched.
 */
export function link(i: number, state: LinkState) {
  const server = branchServer(i);
  const script = [
    'iptables -N LAB 2>/dev/null || true',
    'iptables -C OUTPUT -j LAB 2>/dev/null || iptables -I OUTPUT 1 -j LAB',
    'iptables -C DOCKER-USER -j LAB 2>/dev/null || iptables -I DOCKER-USER 1 -j LAB',
    'iptables -F LAB',
    'tc qdisc del dev eth0 root 2>/dev/null || true',
  ];
  if (state === 'down') script.push(`iptables -A LAB -d ${CLOUD_IP} -j DROP`);
  if (state === 'refuse')
    script.push(
      `iptables -A LAB -p tcp -d ${CLOUD_IP} -j REJECT --reject-with tcp-reset`,
      `iptables -A LAB -d ${CLOUD_IP} -j REJECT`,
    );
  if (state === 'slow')
    script.push(
      // the cloud's traffic through a class of its own with delay and loss; the rest as is
      'tc qdisc add dev eth0 root handle 1: htb default 10',
      'tc class add dev eth0 parent 1: classid 1:10 htb rate 10gbit',
      'tc class add dev eth0 parent 1: classid 1:20 htb rate 10gbit',
      'tc qdisc add dev eth0 parent 1:20 handle 20: netem delay 400ms 150ms loss 5%',
      `tc filter add dev eth0 protocol ip parent 1: prio 1 u32 match ip dst ${CLOUD_IP}/32 flowid 1:20`,
    );
  onServer(server, ['sh', '-ec', script.join('\n')]);
  links.set(i, state);
}

/** Whether the kernel of this machine has netem, which a slow line needs ('slow'). */
export function netemAvailable(): boolean {
  const run = ['run', '--rm', '--privileged', '--entrypoint', 'tc', SERVER_IMAGE];
  const probe = 'qdisc add dev eth0 root netem delay 1ms'.split(' ');
  return spawnSync('docker', [...run, ...probe], { stdio: 'ignore' }).status === 0;
}

/** Branch i's server loses power ('off', every process killed) or comes back ('on'). */
export async function power(i: number, state: 'off' | 'on') {
  const server = branchServer(i);
  if (state === 'off') {
    sh('docker', ['kill', server]);
    return;
  }
  agentIps.delete(i);
  sh('docker', ['start', server]);
  await serverDocker(server);
  // the line as it was (the firewall rules went with the power)
  link(i, links.get(i) ?? 'up');
}

export async function down() {
  for (const server of [cloudServer, branchServer(1), branchServer(2)])
    quiet('docker', ['rm', '-fv', server]);
  quiet('docker', ['network', 'rm', NET]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const what = process.argv[2];
  if (what === 'build') build();
  else if (what === 'up') await up();
  else if (what === 'down') await down();
  else {
    console.error('node e2e/lab/lab.ts build|up|down');
    process.exit(1);
  }
  console.log(`lab ${what}`);
}

export const labReady = () => existsSync(path.join(WORK, 'lab.json'));
