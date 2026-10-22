import '../modules.ts';
import { listModules } from '@hubium/core';
import { NodeReplicas } from '@hubium/core/node/replicas';
import { lsnValue } from '@hubium/core/node/replication';
import { initialNodeState, setNodeState } from '@hubium/core/node/runtime';
import { log } from '@hubium/log';
import { BusRelay } from './bus.ts';
import { refreshCertificates } from './certs.ts';
import { CloudError, cloudCall } from './cloud.ts';
import { startControl } from './control.ts';
import { FileMirror } from './files.ts';
import { startGateway } from './gateway.ts';
import { journal } from './journal.ts';
import { ModeMachine, type Observed } from './modes.ts';
import { agentSettings } from './settings.ts';
import { syncJournal } from './sync.ts';
import { runOfflineTasks } from './tasks.ts';
import { TouchQueue } from './touches.ts';

// The agent of a local node (HUBIUM_ROLE=node): the gateway the network reaches the LMS
// through, the node's mode (modes.ts), its heartbeats to the cloud, the bus for the node's
// web server, and the side records of page views on their way to the cloud.

const logger = log('node-agent');
const s = agentSettings();
const replicas = new NodeReplicas({
  a: s.databaseA,
  b: s.databaseB || undefined,
  controlA: s.controlA,
  controlB: s.controlB,
});

const machine = new ModeMachine(
  {
    release: s.release,
    offlineAfterMs: s.offlineAfterMs,
    promoteB: () => replicas.promoteB(),
    copyB: () => replicas.requestCopy('b'),
    sync: () => syncJournal(s, replicas),
    pendingOps: () => journal(replicas).pending(),
    runningTimedAttempts: () => journal(replicas).runningTimedAttempts(),
  },
  initialNodeState(s.release),
);
const publish = () => setNodeState(machine.state);
publish();

const bus = new BusRelay(s, () => replicas.replayedA());
const touches = new TouchQueue(s, () => machine.state.mode === 'ONLINE');
const files = new FileMirror(s, replicas, () => machine.state.mode);

const observed: Pick<Observed, 'cloudOk' | 'cloudRelease' | 'cloudLsn'> = {
  cloudOk: false,
  cloudRelease: null,
  cloudLsn: null,
};

let renewing = false;

async function heartbeat() {
  try {
    const r = await cloudCall<{
      release: string;
      lsn: string;
      categoryIds: string[];
      slot: { walStatus: string | null };
    }>(
      s,
      'POST',
      'heartbeat',
      {
        mode: machine.state.mode,
        release: s.release,
        status: {
          lagBytes: machine.state.lagBytes,
          replicaB: machine.state.replicaB,
          files: machine.state.files,
          pendingOps: machine.state.pendingOps,
          offlineSince: machine.state.offlineSince,
          syncPostponedUntil: machine.state.syncPostponedUntil,
          error: machine.state.error,
        },
      },
      // a line that went down shows as a heartbeat without an answer
      Math.max(3000, s.heartbeatMs * 1.5),
    );
    observed.cloudOk = true;
    observed.cloudRelease = r.release;
    observed.cloudLsn = r.lsn;
    files.categoryIds = r.categoryIds;
    machine.cloudAnswered();
    machine.state = { ...machine.state, lastHeartbeatAt: new Date().toISOString() };
    // away longer than the cloud kept WAL for: a new slot and a new copy of the database
    if (r.slot.walStatus === 'lost' && !renewing) {
      renewing = true;
      logger.warn('the cloud lost this node’s replication slot: copying the database again');
      await cloudCall(s, 'POST', 'slot');
      await replicas.requestCopy('a');
      // B in use holds the journal: it is copied anew after the sync, as always
      if (s.databaseB && machine.state.replicaB !== 'promoted') await replicas.requestCopy('b');
      setTimeout(() => (renewing = false), 60_000);
    }
  } catch (err) {
    observed.cloudOk = false;
    machine.cloudFailed();
    if (err instanceof CloudError && err.status === 401)
      machine.state = { ...machine.state, error: 'The cloud does not know this node (revoked?)' };
    logger.debug({ err }, 'heartbeat failed');
  }
}

async function tick() {
  const [a, b] = await Promise.all([replicas.replicaA(), replicas.replicaB()]);
  await machine.tick({ ...observed, a, b });
  machine.state = { ...machine.state, files: files.progress };
  publish();
  bus.follow(machine.state.mode);
  if (machine.state.mode === 'ONLINE') void touches.flush();
}

/** Until replica A has replayed `lsn`, at most `ms`. */
let replayed: bigint | null = null;
async function waitForLsn(lsn: string, ms: number): Promise<boolean> {
  const want = lsnValue(lsn);
  const until = Date.now() + ms;
  for (;;) {
    if (replayed !== null && replayed >= want) return true;
    replayed = await replicas.replayedA();
    if (replayed !== null && replayed >= want) return true;
    if (Date.now() >= until) return false;
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

startGateway({
  s,
  mode: () => machine.state.mode,
  externalModules: listModules()
    .filter((m) => m.httpExternal)
    .map((m) => m.key),
  waitForLsn,
  cloudLsn: () => cloudCall<{ lsn: string }>(s, 'GET', 'lsn', undefined, 5000).then((r) => r.lsn),
  cloudUnreachable: () => machine.cloudFailed(),
});
startControl({
  s,
  state: () => machine.state,
  bus,
  touch: (item) => touches.add(item),
  fetchFile: (key) => files.fetch(key),
  command: async (action, until) => {
    await machine.command(action, until);
    publish();
  },
});

const loop = (fn: () => Promise<void>, ms: number) => {
  const run = () =>
    fn()
      .catch((err) => logger.error({ err }, 'agent step failed'))
      .finally(() => setTimeout(run, ms));
  void run();
};
loop(heartbeat, s.heartbeatMs);
loop(tick, 1000);
loop(async () => {
  replayed = await replicas.replayedA();
}, 200);
loop(() => files.preload(), 60_000);
loop(async () => {
  if (machine.state.mode === 'OFFLINE') await runOfflineTasks();
}, 60_000);
// the cloud's certificates: within a second of the cloud's first answer (Caddy cannot serve
// without them on a node just installed, and the line may go soon after), then every ten
// minutes; a failure is tried again in a minute
let certificatesNext = 0;
loop(async () => {
  if (!observed.cloudOk || Date.now() < certificatesNext) return;
  certificatesNext = Date.now() + 60_000;
  await refreshCertificates(s);
  certificatesNext = Date.now() + 600_000;
}, 1000);

logger.info(
  { nodeId: s.node.id, gateway: s.gatewayPort, control: s.controlPort, release: s.release },
  'node agent started',
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'node agent stopping');
  await replicas.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
