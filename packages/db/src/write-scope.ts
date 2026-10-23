import { AsyncLocalStorage } from 'node:async_hooks';
import { newSeed, type Random, seededRandom } from './random.ts';

// What a write to the database belongs to. A local node records the operations people run
// and replays them in the cloud (docs/PLAN.md), so every write has to belong to one of:
// - operation: an operation or a module action, the changes people make;
// - touch: a side record of a page view (last access, viewed);
// - derived: data that can be computed again (caches, totals);
// - files: the registry of stored blobs and the sessions of uploads;
// - external: the records of exchanges with systems outside Hubium (an AI provider, an LTI
//   tool, a webinar server), which only the cloud makes;
// - job: a job or a scheduled task of the worker;
// - auth: Better Auth's own tables;
// - node: the cloud's records of its local nodes (heartbeats, outages, replay results);
// - system: start-up, the seed and the other commands of the CLI.
// The write guard (write-guard.ts) reports or refuses writes outside any of them.
// An operation's scope also carries its time and its random numbers (random.ts), so that
// what it writes depends on its input, the database and those two: the cloud replaying an
// operation of a local node gives them the values the node had.

export type WriteScopeKind =
  | 'operation'
  | 'touch'
  | 'derived'
  | 'files'
  | 'external'
  | 'job'
  | 'auth'
  | 'node'
  | 'system';

/**
 * What a local node records of an operation it runs without a connection, for the cloud to
 * do the same (packages/core/src/node/journal.ts): the ids it made by model, in order (ids
 * made outside a model under '#'), the rows it changed as they were before (guarded
 * operations only), and the files it stored.
 */
export interface OpRecord {
  ids: Record<string, string[]>;
  guards: { model: string; where: Record<string, unknown>; hash: string | null }[] | null;
  files: Set<string>;
  /** Uploads it consumed (by upload id): their content stored under these keys. */
  uploads: Record<string, JournalUpload>;
}

export interface JournalUpload {
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * The cloud replaying an operation of a node's journal: the k-th row of a model it makes
 * gets the k-th id the node made for that model, so links people saw keep working even
 * where the cloud's state makes the operation skip a row the node made (a file it holds).
 */
export interface OpReplay {
  ids: Record<string, string[]>;
  next: Record<string, number>;
  seed: string;
  uploads: Record<string, JournalUpload>;
  /**
   * Records the entry as done, in the transaction of the operation that replays it: the
   * cloud has its changes if and only if it has its result, so a sync cut off and sent
   * again does each entry once.
   */
  commit?: (tx: never) => Promise<void>;
}

export interface WriteScope {
  kind: WriteScopeKind;
  /** The operation, job or command, for reports. */
  name: string;
  /** When the operation runs: what it writes is dated so. */
  now?: Date;
  /** The operation's random numbers. */
  random?: Random;
  record?: OpRecord;
  replay?: OpReplay;
}

// One store in the process: a bundler may load this module more than once (Next.js does
// for its server bundles), and the guard must see the scope whichever copy opened it.
const shared = globalThis as unknown as { hubiumWriteScopes?: AsyncLocalStorage<WriteScope> };
const scopes = (shared.hubiumWriteScopes ??= new AsyncLocalStorage<WriteScope>());

/**
 * Runs `fn` with its writes belonging to `kind`. It awaits inside the scope: Prisma runs a
 * query only when its promise is awaited, so a query returned unawaited would run outside.
 */
export function withWriteScope<T>(
  kind: WriteScopeKind,
  name: string,
  fn: () => T | PromiseLike<T>,
  /**
   * Its time and the seed of its random numbers, what it records or replays; a scope inside
   * another keeps the outer's.
   */
  opts: { now?: Date; seed?: string; record?: OpRecord; replay?: OpReplay } = {},
): Promise<T> {
  const outer = scopes.getStore();
  const scope: WriteScope = {
    kind,
    name,
    now: opts.now ?? outer?.now,
    random: opts.seed ? seededRandom(opts.seed) : outer?.random,
    record: opts.record ?? outer?.record,
    replay: opts.replay ?? outer?.replay,
  };
  return scopes.run(scope, async () => await fn());
}

/** A new, empty record of an operation (guarded: with the rows it changes). */
export function newOpRecord(guarded: boolean): OpRecord {
  return { ids: {}, guards: guarded ? [] : null, files: new Set(), uploads: {} };
}

/** The time of the operation the code runs in, or the clock's outside any. */
export function opNow(): Date {
  const now = scopes.getStore()?.now;
  return now ? new Date(now.getTime()) : new Date();
}

/** The random numbers of the operation the code runs in; a fresh generator outside any. */
export function opRandom(): Random {
  return scopes.getStore()?.random ?? seededRandom(newSeed());
}

/** The scope the current code runs in; undefined outside any. */
export function currentWriteScope(): WriteScope | undefined {
  return scopes.getStore();
}
