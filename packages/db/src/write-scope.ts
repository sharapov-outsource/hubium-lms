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
  | 'system';

export interface WriteScope {
  kind: WriteScopeKind;
  /** The operation, job or command, for reports. */
  name: string;
  /** When the operation runs: what it writes is dated so. */
  now?: Date;
  /** The operation's random numbers. */
  random?: Random;
}

const scopes = new AsyncLocalStorage<WriteScope>();

/**
 * Runs `fn` with its writes belonging to `kind`. It awaits inside the scope: Prisma runs a
 * query only when its promise is awaited, so a query returned unawaited would run outside.
 */
export function withWriteScope<T>(
  kind: WriteScopeKind,
  name: string,
  fn: () => T | PromiseLike<T>,
  /** Its time and the seed of its random numbers; a scope inside another keeps the outer's. */
  opts: { now?: Date; seed?: string } = {},
): Promise<T> {
  const outer = scopes.getStore();
  const scope: WriteScope = {
    kind,
    name,
    now: opts.now ?? outer?.now,
    random: opts.seed ? seededRandom(opts.seed) : outer?.random,
  };
  return scopes.run(scope, async () => await fn());
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
