import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { lsnValue } from './replication.ts';

// The node's two databases as its agent sees them (docker/node/replica.sh runs each):
// A, the replica of the cloud's database, and B, the node's own copy (a replica of A until
// the node needs it). The agent asks for a new copy of either by creating `rebuild` in its
// control directory; the container writes its state to `state` there.

export type ReplicaBState = 'ready' | 'copying' | 'promoted' | 'missing';

export interface ReplicaAState {
  /** Up and replaying the cloud's WAL. */
  ready: boolean;
  /** How far it has replayed. */
  replayLsn: string | null;
  /** Its connection to the cloud: streaming, or not connected. */
  streaming: boolean;
  /** A new copy is being made. */
  copying: boolean;
}

export class NodeReplicas {
  private readonly a: pg.Pool;
  private readonly b: pg.Pool | null;
  private readonly controlA: string;
  private readonly controlB: string;

  constructor(opts: { a: string; b?: string; controlA: string; controlB: string }) {
    const pool = (connectionString: string) => {
      const p = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000 });
      p.on('error', () => {});
      return p;
    };
    this.a = pool(opts.a);
    this.b = opts.b ? pool(opts.b) : null;
    this.controlA = opts.controlA;
    this.controlB = opts.controlB;
  }

  private async containerState(dir: string): Promise<string | null> {
    try {
      return (await readFile(path.join(dir, 'state'), 'utf8')).split(' ')[0]!.trim();
    } catch {
      return null;
    }
  }

  async replicaA(): Promise<ReplicaAState> {
    const copying = (await this.containerState(this.controlA)) === 'copying';
    try {
      const { rows } = await this.a.query<{
        recovery: boolean;
        lsn: string | null;
        status: string | null;
      }>(
        `SELECT pg_is_in_recovery() AS recovery, pg_last_wal_replay_lsn()::text AS lsn,
                (SELECT status FROM pg_stat_wal_receiver) AS status`,
      );
      const r = rows[0]!;
      return {
        ready: r.recovery && !!r.lsn,
        replayLsn: r.lsn,
        streaming: r.status === 'streaming',
        copying,
      };
    } catch {
      return { ready: false, replayLsn: null, streaming: false, copying };
    }
  }

  /** How far A has replayed (cheap: for the gateway's waits). */
  async replayedA(): Promise<bigint | null> {
    try {
      const { rows } = await this.a.query<{ lsn: string | null }>(
        'SELECT pg_last_wal_replay_lsn()::text AS lsn',
      );
      return rows[0]?.lsn ? lsnValue(rows[0].lsn) : null;
    } catch {
      return null;
    }
  }

  async replicaB(): Promise<ReplicaBState> {
    if (!this.b) return 'missing';
    const container = await this.containerState(this.controlB);
    if (container === 'copying') return 'copying';
    try {
      const { rows } = await this.b.query<{ recovery: boolean }>(
        'SELECT pg_is_in_recovery() AS recovery',
      );
      return rows[0]!.recovery ? 'ready' : 'promoted';
    } catch {
      return 'missing';
    }
  }

  /** Makes B the node's own database: it stops following A and takes writes. */
  async promoteB(): Promise<void> {
    if (!this.b) throw new Error('The node has no database of its own (NODE_DATABASE_B_URL)');
    const { rows } = await this.b.query<{ done: boolean }>('SELECT pg_promote(true, 60) AS done');
    if (!rows[0]?.done) throw new Error('The node database did not take over in a minute');
  }

  /** Asks the container of A or B for a new copy of its upstream. */
  async requestCopy(which: 'a' | 'b'): Promise<void> {
    await writeFile(path.join(which === 'a' ? this.controlA : this.controlB, 'rebuild'), '');
  }

  /** The replica, for the agent's reads (what files to copy). */
  get replica(): pg.Pool {
    return this.a;
  }

  /** The node's own database, for the agent's reads and writes there (journal, LISTEN). */
  get ownDatabase(): pg.Pool | null {
    return this.b;
  }

  async end(): Promise<void> {
    await Promise.all([this.a.end(), this.b?.end()]);
  }
}
