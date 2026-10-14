import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundledMigrations, checkDatabase } from './doctor.ts';
import { createTestDatabase, prepareTemplateDatabase, type TestDatabase } from './testing.ts';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const migrationsDir = path.resolve(import.meta.dirname, '../prisma/migrations');
const suffix = randomBytes(4).toString('hex');
const emptyDb = `hubium_doctor_${suffix}`;
const role = `hubium_doctor_${suffix}`;

function urlFor(db: string, user?: { name: string; password: string }) {
  const u = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

async function admin(sql: string, db = 'postgres') {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

const errors = (r: Awaited<ReturnType<typeof checkDatabase>>) =>
  r.checks.filter((c) => c.status === 'error').map((c) => c.key);

describe('database checks', () => {
  let migrated: TestDatabase;

  beforeAll(async () => {
    await prepareTemplateDatabase();
    migrated = await createTestDatabase();
    await admin(`CREATE DATABASE ${emptyDb}`);
    await admin(`CREATE ROLE ${role} LOGIN PASSWORD 'doctor-check'`);
  }, 120_000);

  afterAll(async () => {
    await migrated?.drop();
    await admin(`DROP DATABASE IF EXISTS ${emptyDb} WITH (FORCE)`);
    await admin(`DROP ROLE IF EXISTS ${role}`);
  });

  it('accepts an empty database and lists every migration as pending', async () => {
    const r = await checkDatabase(urlFor(emptyDb), { migrationsDir });
    expect(r.state).toBe('empty');
    expect(errors(r)).toEqual([]);
    expect(r.pending).toEqual(bundledMigrations(migrationsDir));
    expect(r.pending.length).toBeGreaterThan(10);
  });

  it('knows a migrated Hubium database, and one newer than this build', async () => {
    const r = await checkDatabase(migrated.url, { migrationsDir });
    expect(r).toMatchObject({ state: 'hubium', pending: [], failed: [] });
    expect(errors(r)).toEqual([]);
    await migrated.db.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
       VALUES ('future', 'x', '29991231000000_future', now(), now(), 1)`,
    );
    const newer = await checkDatabase(migrated.url, { migrationsDir });
    expect(newer.checks.find((c) => c.key === 'migrations')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('newer than this Hubium version'),
    });
  });

  it('tells what a role without rights needs from the DBA', async () => {
    const r = await checkDatabase(urlFor(emptyDb, { name: role, password: 'doctor-check' }), {
      migrationsDir,
    });
    expect(errors(r)).toEqual(expect.arrayContaining(['extension:vector', 'schema']));
    expect(r.checks.find((c) => c.key === 'extension:vector')?.fix).toContain(
      'CREATE EXTENSION IF NOT EXISTS "vector"',
    );
    expect(r.checks.find((c) => c.key === 'schema')?.fix).toContain('GRANT CREATE ON SCHEMA');
  });

  it('refuses a database with other tables', async () => {
    await admin('CREATE TABLE wordpress_posts (id int)', emptyDb);
    const r = await checkDatabase(urlFor(emptyDb), { migrationsDir });
    expect(r.state).toBe('foreign');
    expect(errors(r)).toEqual(['migrations']);
  });

  it('reports a server it cannot reach without throwing', async () => {
    const r = await checkDatabase('postgresql://nobody:secret@127.0.0.1:1/none', {
      migrationsDir,
      timeoutMs: 1000,
    });
    expect(r.state).toBe('unreachable');
    expect(r.checks[0]!.detail).not.toContain('secret');
  });
});
