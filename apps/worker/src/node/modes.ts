import type { ReplicaAState, ReplicaBState } from '@hubium/core/node/replicas';
import { lsnValue } from '@hubium/core/node/replication';
import type { NodeMode, NodeState } from '@hubium/core/node/runtime';
import { log } from '@hubium/log';

// The modes of a local node (docs/architecture.md §1.7):
//   PASSTHROUGH  the replica is not ready, or the node runs another release than the cloud:
//                everything goes to the cloud
//   ONLINE       reads from the replica (A), changes go to the cloud
//   READONLY     the cloud has not been reachable for a while: reads only
//   OFFLINE      unreachable longer than NODE_OFFLINE_AFTER (or the node admin said so):
//                the node works on its own database (B) and keeps a journal
//   SYNC         reachable again: the journal goes to the cloud, reads only; then ONLINE
//                once A has everything, and B is copied again from A
// The machine decides from what it observes, once a second.

const logger = log('node-agent');

/** Failed heartbeats in a row (or a failed request) before the node counts as cut off. */
const FAILURES = 2;

export interface Observed {
  /** The last heartbeat answered, and what the cloud said. */
  cloudOk: boolean;
  cloudRelease: string | null;
  cloudLsn: string | null;
  a: ReplicaAState;
  b: ReplicaBState;
}

export interface MachineDeps {
  release: string;
  offlineAfterMs: number;
  promoteB(): Promise<void>;
  copyB(): Promise<void>;
  /**
   * The sync: sends the journal; done once the cloud has every entry, with the cloud's WAL
   * position after the last one (the replica must reach it before the node reads it again).
   */
  sync(): Promise<{ done: boolean; lsn?: string }>;
  /** Entries of the journal not yet taken. */
  pendingOps(): Promise<number>;
  /** Quizzes with a time limit someone is still answering on the node. */
  runningTimedAttempts(): Promise<number>;
  now?: () => number;
}

/** How long B stays as it is after the node reads A again: requests on it finish first. */
const B_RELEASE_MS = 5000;

/** Longest the sync waits for timed quizzes started without a connection. */
const QUIZ_WAIT_MS = 3 * 3_600_000;

export class ModeMachine {
  state: NodeState;
  private failures = 0;
  private firstFailureAt: number | null = null;
  /** The node admin turned the autonomous mode on: it stays until they turn it off. */
  private manualOffline = false;
  private syncing = false;
  private syncReadyAt: number | null = null;
  /** The cloud's position after the journal: the replica's goal before ONLINE. */
  private syncLsn: string | null = null;
  private readonly deps: MachineDeps;

  constructor(deps: MachineDeps, initial: NodeState) {
    this.deps = deps;
    this.state = initial;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private enter(mode: NodeMode, why: string) {
    if (this.state.mode === mode) return;
    logger.info({ from: this.state.mode, to: mode, why }, 'node mode');
    this.state = { ...this.state, mode, since: new Date(this.now()).toISOString() };
  }

  /** A heartbeat or a request to the cloud failed. */
  cloudFailed(): void {
    this.failures++;
    this.firstFailureAt ??= this.now();
  }

  cloudAnswered(): void {
    this.failures = 0;
    this.firstFailureAt = null;
  }

  private get cutOff() {
    return this.failures >= FAILURES;
  }

  /** The node admin's commands. */
  async command(action: 'offline' | 'online' | 'postpone', until?: string): Promise<void> {
    if (action === 'offline') {
      this.manualOffline = true;
      await this.tickWith(null);
    } else if (action === 'online') {
      this.manualOffline = false;
      this.state = { ...this.state, syncPostponedUntil: null };
    } else {
      this.state = { ...this.state, syncPostponedUntil: until ?? null };
    }
  }

  private last: Observed | null = null;

  async tick(o: Observed): Promise<void> {
    this.last = o;
    await this.tickWith(o);
  }

  private async tickWith(observed: Observed | null): Promise<void> {
    const o = observed ?? this.last;
    if (!o) return;
    const s = this.state;
    const lag =
      o.cloudLsn && o.a.replayLsn ? Number(lsnValue(o.cloudLsn) - lsnValue(o.a.replayLsn)) : null;
    this.state = {
      ...s,
      replicaB: s.mode === 'OFFLINE' || s.mode === 'SYNC' ? 'promoted' : o.b,
      lagBytes: lag === null ? null : Math.max(0, lag),
      cloudRelease: o.cloudRelease ?? s.cloudRelease,
      offlineSince: this.cutOff
        ? (s.offlineSince ?? new Date(this.firstFailureAt ?? this.now()).toISOString())
        : s.mode === 'OFFLINE' || s.mode === 'SYNC'
          ? s.offlineSince
          : null,
      pendingOps: await this.deps.pendingOps().catch(() => s.pendingOps),
    };
    const sameRelease = !o.cloudRelease || o.cloudRelease === this.deps.release;
    switch (this.state.mode) {
      case 'PASSTHROUGH':
      case 'ONLINE':
      case 'READONLY': {
        if (this.manualOffline || (this.cutOff && this.offlineLongEnough())) {
          if (this.state.replicaB === 'ready') return this.goOffline();
        }
        if (this.cutOff) {
          // without the cloud the replica is all there is to read
          if (o.a.ready) this.enter('READONLY', 'the cloud is not reachable');
          return;
        }
        if (!o.cloudOk) return;
        if (!sameRelease) return this.enter('PASSTHROUGH', 'the cloud runs another release');
        if (!o.a.ready) return this.enter('PASSTHROUGH', 'the replica is not ready');
        return this.enter('ONLINE', 'connected');
      }
      case 'OFFLINE': {
        if (this.manualOffline || this.cutOff || !o.cloudOk) return;
        const until = this.state.syncPostponedUntil;
        if (until && Date.parse(until) > this.now()) return;
        // timed quizzes started here finish here first, up to a limit
        if ((await this.deps.runningTimedAttempts().catch(() => 0)) > 0) {
          this.syncReadyAt ??= this.now();
          if (this.now() - this.syncReadyAt < QUIZ_WAIT_MS) return;
        }
        this.syncReadyAt = null;
        this.enter('SYNC', 'the cloud is reachable again');
        return this.runSync();
      }
      case 'SYNC':
        return this.runSync();
    }
  }

  private offlineLongEnough() {
    return (
      this.firstFailureAt !== null && this.now() - this.firstFailureAt >= this.deps.offlineAfterMs
    );
  }

  private async goOffline() {
    try {
      await this.deps.promoteB();
      this.state = { ...this.state, replicaB: 'promoted' };
      this.state.offlineSince ??= new Date(this.now()).toISOString();
      this.enter('OFFLINE', this.manualOffline ? 'turned on by the node admin' : 'no connection');
    } catch (err) {
      logger.error({ err }, 'the node database could not take over');
      this.state = { ...this.state, error: 'The node database could not take over' };
    }
  }

  private async runSync() {
    if (this.syncing || !this.last) return;
    this.syncing = true;
    try {
      if (!this.syncLsn) {
        const r = await this.deps.sync();
        if (!r.done || !r.lsn) return;
        this.syncLsn = r.lsn;
      }
      // the cloud has the journal; once the replica has the cloud's state, read it again
      const a = this.last.a;
      if (!a.ready || !a.replayLsn || lsnValue(a.replayLsn) < lsnValue(this.syncLsn)) return;
      this.syncLsn = null;
      this.state = { ...this.state, offlineSince: null, pendingOps: 0, error: null };
      this.enter('ONLINE', 'the journal is in the cloud');
      // requests that began on B finish before it is copied anew
      await new Promise((ok) => setTimeout(ok, B_RELEASE_MS));
      await this.deps.copyB();
      this.state = { ...this.state, replicaB: 'copying' };
    } catch (err) {
      logger.warn({ err }, 'sync failed; retrying');
    } finally {
      this.syncing = false;
    }
  }
}
