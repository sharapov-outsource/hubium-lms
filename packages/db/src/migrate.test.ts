import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundledMigrations } from './doctor.ts';
import { deployMigrations, MigrationError, markRolledBack } from './migrate.ts';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const pkgRoot = path.resolve(import.meta.dirname, '..');
const migrationsDir = path.join(pkgRoot, 'prisma/migrations');
const suffix = randomBytes(4).toString('hex');
const ours = `hubium_migrate_${suffix}`;
const broken = `hubium_migrate_bad_${suffix}`;

function urlFor(db: string) {
  const u = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

async function query<T>(db: string, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  try {
    return (await c.query(sql)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Prisma's own CLI against a database. */
function prisma(db: string, ...args: string[]): string {
  return execFileSync('npx', ['prisma', ...args], {
    cwd: pkgRoot,
    env: { ...process.env, DATABASE_URL: urlFor(db), CHECKPOINT_DISABLE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('release migrations', () => {
  beforeAll(async () => {
    await query('postgres', `CREATE DATABASE ${ours}`);
    await query('postgres', `CREATE DATABASE ${broken}`);
  });
  afterAll(async () => {
    await query('postgres', `DROP DATABASE IF EXISTS ${ours} WITH (FORCE)`);
    await query('postgres', `DROP DATABASE IF EXISTS ${broken} WITH (FORCE)`);
  });

  it('applies every migration once, and Prisma agrees with the result', async () => {
    const names: string[] = [];
    const applied = await deployMigrations(urlFor(ours), migrationsDir, (n) => names.push(n));
    expect(applied).toEqual(bundledMigrations(migrationsDir));
    expect(names).toEqual(applied);
    expect(await deployMigrations(urlFor(ours), migrationsDir)).toEqual([]);

    expect(prisma(ours, 'migrate', 'status')).toContain('Database schema is up to date');
    expect(prisma(ours, 'migrate', 'deploy')).toContain('No pending migrations to apply');
    // the tables, indexes and functions are the ones the schema describes
    expect(
      execFileSync('node', ['scripts/check-drift.mjs'], {
        cwd: pkgRoot,
        env: {
          ...process.env,
          DATABASE_URL: urlFor(ours),
          PATH: `${pkgRoot}/node_modules/.bin:${process.env.PATH}`,
        },
        encoding: 'utf8',
      }),
    ).toContain('No schema drift');
  }, 120_000);

  it('records a failed migration, rolls its statements back and stops there', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hubium-migrations-'));
    const add = (name: string, sql: string) => {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, 'migration.sql'), sql);
    };
    add('20000101000000_first', 'CREATE TABLE first_table (id int);');
    add('20000102000000_broken', 'CREATE TABLE second_table (id int);\nSELECT no_such_column;');
    await expect(deployMigrations(urlFor(broken), dir)).rejects.toThrow(
      'Migration 20000102000000_broken failed',
    );
    const tables = await query<{ t: string | null }>(
      broken,
      `SELECT to_regclass('second_table')::text AS t`,
    );
    expect(tables[0]!.t).toBeNull();
    const rows = await query<{ migration_name: string; finished_at: Date | null; logs: string }>(
      broken,
      'SELECT migration_name, finished_at, logs FROM _prisma_migrations ORDER BY 1',
    );
    expect(rows.map((r) => [r.migration_name, !!r.finished_at])).toEqual([
      ['20000101000000_first', true],
      ['20000102000000_broken', false],
    ]);
    expect(rows[1]!.logs).toContain('no_such_column');
    await expect(deployMigrations(urlFor(broken), dir)).rejects.toBeInstanceOf(MigrationError);

    // fixed and marked as rolled back, the next deploy applies it again
    writeFileSync(
      path.join(dir, '20000102000000_broken', 'migration.sql'),
      'CREATE TABLE second_table (id int);',
    );
    expect(await markRolledBack(urlFor(broken), '20000101000000_first')).toBe(false);
    expect(await markRolledBack(urlFor(broken), '20000102000000_broken')).toBe(true);
    expect(await deployMigrations(urlFor(broken), dir)).toEqual(['20000102000000_broken']);
  });
});
