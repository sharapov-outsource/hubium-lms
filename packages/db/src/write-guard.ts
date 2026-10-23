import { log } from '@hubium/log';
import type { PrismaClient } from './generated/prisma/client.ts';
import { routedClient, routeOf } from './node-router.ts';
import { currentWriteScope, type WriteScopeKind, withWriteScope } from './write-scope.ts';

// Checks that every write to the database runs in a write scope (write-scope.ts). Off by
// default; HUBIUM_WRITE_GUARD=report logs each kind of write found outside a scope once,
// strict refuses it, so the tests and the e2e scenarios find writes that a local node
// would not record.

export type WriteGuardMode = 'off' | 'report' | 'strict';

const logger = log('db');

const MODEL_WRITES = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

// Statements that change rows. pg_notify, SELECT … FOR UPDATE and DDL do not.
const ROW_WRITE = /\binsert\s+into\b|\bupdate\s+[\w".]+\s+set\b|\bdelete\s+from\b|\btruncate\b/i;

export function isRowWrite(sql: string): boolean {
  return ROW_WRITE.test(sql);
}

export class UnscopedWriteError extends Error {
  readonly write: string;
  constructor(write: string) {
    super(`${write} runs outside an operation (HUBIUM_WRITE_GUARD=strict)`);
    this.name = 'UnscopedWriteError';
    this.write = write;
  }
}

export function writeGuardMode(value = process.env.HUBIUM_WRITE_GUARD): WriteGuardMode {
  if (!value || value === 'off') return 'off';
  if (value === 'report' || value === 'strict') return value;
  throw new Error(`HUBIUM_WRITE_GUARD must be off, report or strict, not "${value}"`);
}

/** The SQL of a raw query's arguments: a Prisma.Sql, or the string and values of *Unsafe. */
function rawSql(args: unknown): string {
  if (Array.isArray(args)) return typeof args[0] === 'string' ? args[0] : '';
  const sql = (args as { sql?: unknown } | null)?.sql;
  return typeof sql === 'string' ? sql : '';
}

// Guarded clients and what they guard: inWriteScope puts its scope before the guard. One
// map in the process, as for the scopes (write-scope.ts).
type Guarded = WeakMap<object, { base: PrismaClient; mode: 'report' | 'strict' }>;
const shared = globalThis as unknown as { hubiumGuardedClients?: Guarded };
const guarded = (shared.hubiumGuardedClients ??= new WeakMap());

// A local node working alone (packages/core/src/node/journal.ts) also needs every change
// people make in its journal: a write of an operation or a page view without its record
// would be lost to the cloud, and so would one of an exchange with an outside system.
const journal = globalThis as unknown as { hubiumJournalRequired?: () => boolean };

/** Set by a node's runtime: whether writes must go to the journal now. */
export function setJournalRequired(fn: () => boolean): void {
  journal.hubiumJournalRequired = fn;
}

export class UnjournaledWriteError extends Error {
  readonly write: string;
  constructor(write: string) {
    super(`${write} runs outside the journal of a node working without a connection`);
    this.name = 'UnjournaledWriteError';
    this.write = write;
  }
}

/** Whether a write in this scope is lost to the cloud: a node working alone without its record. */
function unjournaled(): boolean {
  if (!journal.hubiumJournalRequired?.()) return false;
  const scope = currentWriteScope();
  if (!scope) return false;
  if (scope.kind === 'external') return true;
  return (scope.kind === 'operation' || scope.kind === 'touch') && !scope.record;
}

/** The client with the guard. A query extension leaves the client's API as it is. */
export function withWriteGuard(client: PrismaClient, mode: 'report' | 'strict'): PrismaClient {
  const reported = new Set<string>();
  const check = (write: string) => {
    if (unjournaled()) {
      if (mode === 'strict') throw new UnjournaledWriteError(write);
      logger.error({ write }, 'database write outside the journal of a node working alone');
      return;
    }
    if (currentWriteScope()) return;
    if (mode === 'strict') throw new UnscopedWriteError(write);
    if (reported.has(write)) return;
    reported.add(write);
    logger.warn({ write }, 'database write outside an operation');
  };
  const out = client.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        if (model) {
          if (MODEL_WRITES.has(operation)) check(`${model}.${operation}`);
        } else {
          const sql = rawSql(args);
          if (isRowWrite(sql))
            check(`${operation} ${sql.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
        }
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
  guarded.set(out, { base: client, mode });
  return out;
}

/** The client whose every query runs in the given scope (the client Better Auth uses). */
export function inWriteScope<T>(client: T, kind: WriteScopeKind, name: string): T {
  const scope = {
    query: {
      $allOperations({ args, query }: { args: unknown; query: (args: unknown) => unknown }) {
        return withWriteScope(kind, name, () => query(args));
      },
    },
  };
  // a node's client over its two databases: each gets the scope
  const route = routeOf(client as object);
  if (route)
    return routedClient(
      inWriteScope(route.a, kind, name),
      inWriteScope(route.b, kind, name),
      route.pick,
    ) as T;
  // Prisma runs extensions in the order they were added, so a guarded client gets its
  // scope added to the client it guards, and the guard again after it.
  const g = guarded.get(client as object);
  if (g) return withWriteGuard(g.base.$extends(scope) as unknown as PrismaClient, g.mode) as T;
  return (client as unknown as PrismaClient).$extends(scope) as unknown as T;
}
