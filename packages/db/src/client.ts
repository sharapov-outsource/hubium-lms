import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';
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
  const client = new PrismaClient({ adapter });
  const guard = options.writeGuard ?? writeGuardMode();
  return guard === 'off' ? client : withWriteGuard(client, guard);
}

const globalForDb = globalThis as unknown as { hubiumDb?: Db };

/** Process-wide client. Reused across hot reloads in development. */
export function getDb(): Db {
  globalForDb.hubiumDb ??= createDb();
  return globalForDb.hubiumDb;
}
