import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';
import { routedClient } from './node-router.ts';
import { withOpContext } from './op-context.ts';
import { type WriteGuardMode, withWriteGuard, writeGuardMode } from './write-guard.ts';

export type Db = PrismaClient;

export interface CreateDbOptions {
  url?: string;
  /** Max pool connections per process. */
  max?: number;
  /** Writes outside a write scope (write-guard.ts); HUBIUM_WRITE_GUARD by default. */
  writeGuard?: WriteGuardMode;
}

export function createDb(options: CreateDbOptions = {}): Db {
  const connectionString = options.url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const adapter = new PrismaPg({ connectionString, max: options.max ?? 10 });
  // ids and times of new rows from the operation that writes them (op-context.ts)
  const client = withOpContext(new PrismaClient({ adapter }));
  // a local node always checks that its writes reach its journal (write-guard.ts)
  const configured = writeGuardMode();
  const guard =
    options.writeGuard ??
    (configured === 'off' && process.env.HUBIUM_ROLE === 'node' ? 'report' : configured);
  return guard === 'off' ? client : withWriteGuard(client, guard);
}

const globalForDb = globalThis as unknown as { hubiumDb?: Db };

/**
 * Process-wide client. Reused across hot reloads in development. On a local node it uses
 * the node's replica (DATABASE_URL) or its own copy (NODE_DATABASE_B_URL), as the node's
 * mode says (node-router.ts).
 */
export function getDb(): Db {
  if (!globalForDb.hubiumDb) {
    const b = process.env.HUBIUM_ROLE === 'node' ? process.env.NODE_DATABASE_B_URL : undefined;
    globalForDb.hubiumDb = b ? routedClient(createDb(), createDb({ url: b })) : createDb();
  }
  return globalForDb.hubiumDb;
}
