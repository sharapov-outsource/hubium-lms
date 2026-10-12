import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { createDb, type Db } from './client.ts';

// Integration-test databases. A template DB is migrated once per test run (globalSetup),
// then each test file clones it with CREATE DATABASE … TEMPLATE, which takes milliseconds.

const TEMPLATE = 'hubium_test_template';
const pkgRoot = path.resolve(import.meta.dirname, '..');

function baseUrl(): URL {
  const raw = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set for integration tests');
  return new URL(raw);
}

function urlFor(db: string): string {
  const u = baseUrl();
  u.pathname = `/${db}`;
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor('postgres') });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Recreates and migrates the template database. Call from vitest globalSetup. */
export async function prepareTemplateDatabase(): Promise<void> {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${TEMPLATE}`);
  });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: pkgRoot,
    env: { ...process.env, DATABASE_URL: urlFor(TEMPLATE) },
    stdio: 'pipe',
  });
}

export interface TestDatabase {
  db: Db;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `hubium_test_${randomBytes(6).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`));
  const url = urlFor(name);
  const db = createDb({ url, max: 5 });
  return {
    db,
    url,
    async drop() {
      await db.$disconnect();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
