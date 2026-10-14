import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  getAllSettings,
  Permissions,
  type RequestContext,
  registerModules,
  siteLocale,
} from '@hubium/core';
import { stopBoss } from '@hubium/core/jobs/jobs';
import { createDb, type Db } from '@hubium/db';
import { serverModules } from '@hubium/modules';
import { UsageError } from './main.ts';

let ready = false;

/** Registers the modules and wires core services, as web and worker do at start. */
export async function loadApp(): Promise<void> {
  if (ready) return;
  await import('@hubium/core/bootstrap');
  registerModules(serverModules as never);
  ready = true;
}

/** Runs `fn` with a database connection that is closed, with pg-boss, afterwards. */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new UsageError('DATABASE_URL is not set.');
  const db = createDb({ max: 3 });
  try {
    return await fn(db);
  } finally {
    await stopBoss().catch(() => {});
    await db.$disconnect();
  }
}

export async function systemCtx(db: Db): Promise<RequestContext> {
  return {
    db,
    actor: { kind: 'system' },
    perm: new Permissions(db, { kind: 'system' }),
    now: new Date(),
    locale: siteLocale(await getAllSettings(db)),
    origin: 'CLI',
  };
}

/**
 * The migrations: next to the bundle in a release (cli/migrations), packages/db in a
 * checkout, or HUBIUM_MIGRATIONS_DIR.
 */
export function migrationsDir(): string {
  if (process.env.HUBIUM_MIGRATIONS_DIR) return process.env.HUBIUM_MIGRATIONS_DIR;
  const release = path.join(import.meta.dirname, 'migrations');
  if (existsSync(release)) return release;
  // apps/cli/{src,dist} in a checkout
  return path.resolve(import.meta.dirname, '../../../packages/db/prisma/migrations');
}

export type Status = 'ok' | 'warn' | 'error';

export function line(status: Status, key: string, detail: string): string {
  const tag = status === 'ok' ? '[ ok ]' : status === 'warn' ? '[warn]' : '[FAIL]';
  return `${tag} ${key.padEnd(20)} ${detail}`;
}
