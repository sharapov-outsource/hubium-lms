import { setJournalRequired, setNodeDatabaseSource } from '@hubium/db';
import { log } from '@hubium/log';
import { isNode, nodeConfig } from './config.ts';

// The mode of a local node, as its processes see it. The agent (the worker in the node
// role) decides it; the web server asks the agent every second and uses the database of
// the mode: the replica (A) while connected, the node's own copy (B) while it works alone
// and while it syncs.

const logger = log('nodes');

export type NodeMode = 'ONLINE' | 'READONLY' | 'OFFLINE' | 'SYNC' | 'PASSTHROUGH';

export interface NodeState {
  mode: NodeMode;
  /** When the node entered this mode. */
  since: string;
  /** Since when the cloud has not been reachable; null while it is. */
  offlineSince: string | null;
  /** The node admin put off the sync until then. */
  syncPostponedUntil: string | null;
  /** The node's own copy: ready to take over, being copied, in use, or not there. */
  replicaB: 'ready' | 'copying' | 'promoted' | 'missing';
  /** How far the replica (A) is behind the cloud, in bytes of WAL; null when unknown. */
  lagBytes: number | null;
  /** Journal entries the cloud has not taken yet. */
  pendingOps: number;
  files: { done: number; total: number; bytes: number } | null;
  /** This release and the cloud's: while they differ the node passes everything on. */
  release: string;
  cloudRelease: string | null;
  lastHeartbeatAt: string | null;
  error: string | null;
}

export function initialNodeState(release = ''): NodeState {
  return {
    mode: 'PASSTHROUGH',
    since: new Date().toISOString(),
    offlineSince: null,
    syncPostponedUntil: null,
    replicaB: 'missing',
    lagBytes: null,
    pendingOps: 0,
    files: null,
    release,
    cloudRelease: null,
    lastHeartbeatAt: null,
    error: null,
  };
}

interface Runtime {
  state: NodeState;
  /** The agent sets the state itself; others ask it. */
  agent: boolean;
  polling: boolean;
}

const shared = globalThis as unknown as { hubiumNodeRuntime?: Runtime };
const rt = (shared.hubiumNodeRuntime ??= {
  state: initialNodeState(),
  agent: false,
  polling: false,
});

const MODES: NodeMode[] = ['ONLINE', 'READONLY', 'OFFLINE', 'SYNC', 'PASSTHROUGH'];

/** The mode at the moment the agent's gateway passed a request on to the web server. */
export const NODE_MODE_HEADER = 'x-hubium-node-mode';

/** Whether the node works on its own copy of the database (B) in this mode. */
export const usesOwnDatabase = (mode: NodeMode) => mode === 'OFFLINE' || mode === 'SYNC';

/** The node's state now (outside a node: never asked). */
export function nodeState(): NodeState {
  if (isNode() && !rt.agent) startNodeRuntime();
  return rt.state;
}

/** In the agent: the state it decided. */
export function setNodeState(state: NodeState): void {
  rt.agent = true;
  rt.state = state;
  follow();
}

/** The database of the mode, and the journal while the node works alone. */
function follow(): void {
  setNodeDatabaseSource(() => (usesOwnDatabase(rt.state.mode) ? 'b' : 'a'));
  setJournalRequired(() => rt.state.mode === 'OFFLINE');
}

/** In the node's web server: follows the agent's state and the database of its mode. */
export function startNodeRuntime(): void {
  if (rt.polling || rt.agent || !isNode()) return;
  rt.polling = true;
  follow();
  const url = `${nodeConfig().agentUrl}/state`;
  let failing = false;
  const tick = async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`the agent answered ${res.status}`);
      rt.state = (await res.json()) as NodeState;
      failing = false;
    } catch (err) {
      // the last state stands until the agent answers again
      if (!failing) logger.warn({ err }, 'node agent not reachable');
      failing = true;
    }
  };
  void tick();
  setInterval(tick, 1000).unref();
}

/**
 * The mode a request came with from the gateway: newer than the last answer to the poll
 * when the agent has just changed it, so the request reads the database of the new mode.
 */
export function noteNodeMode(mode: string | null): void {
  if (rt.agent || !mode || mode === rt.state.mode || !MODES.includes(mode as NodeMode)) return;
  rt.state = { ...rt.state, mode: mode as NodeMode };
}

/** Whether side records of page views go to the node's own database now. */
export function nodeTouchesLocally(): boolean {
  return nodeState().mode === 'OFFLINE';
}

/** A side record for the agent to send to the cloud (or keep until it can). */
export function sendTouchToAgent(t: { kind: string }, at: Date): Promise<void> {
  fetch(`${nodeConfig().agentUrl}/touch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ at: at.toISOString(), touch: t }),
    signal: AbortSignal.timeout(2000),
  }).catch((err) => logger.debug({ err, kind: t.kind }, 'side record not passed to the agent'));
  return Promise.resolve();
}
