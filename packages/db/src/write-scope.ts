import { AsyncLocalStorage } from 'node:async_hooks';

// What a write to the database belongs to. A local node records the operations people run
// and replays them in the cloud (docs/PLAN.md), so every write has to belong to one of:
// - operation: an operation or a module action, the changes people make;
// - touch: a side record of a page view (last access, viewed);
// - derived: data that can be computed again (caches, totals);
// - files: the registry of stored blobs and the sessions of uploads;
// - external: the state of protocols other systems call (LTI, webinar callbacks);
// - job: a job or a scheduled task of the worker;
// - auth: Better Auth's own tables;
// - system: start-up, the seed and the other commands of the CLI.
// The write guard (write-guard.ts) reports or refuses writes outside any of them.

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
): Promise<T> {
  return scopes.run({ kind, name }, async () => await fn());
}

/** The scope the current code runs in; undefined outside any. */
export function currentWriteScope(): WriteScope | undefined {
  return scopes.getStore();
}
