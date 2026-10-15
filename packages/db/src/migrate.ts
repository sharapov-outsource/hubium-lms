import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { bundledMigrations } from './doctor.ts';

// Applies the migrations in prisma/migrations the way `prisma migrate deploy` does, for
// releases (`hubium migrate`): the same _prisma_migrations table, checksums and advisory
// lock, so Prisma's own commands keep working on the database. Releases ship SQL files only,
// without Prisma's CLI and its native schema engine. Development keeps `prisma migrate`.

/** The lock `prisma migrate` takes, so a release and Prisma never migrate at once. */
const PRISMA_LOCK = 72707369;

const TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64) NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
)`;

export class MigrationError extends Error {}

/** Applies the pending migrations in order; returns their names. */
export async function deployMigrations(
  url: string,
  dir: string,
  onApplied: (name: string) => void = () => {},
): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [PRISMA_LOCK]);
    await client.query(TABLE);
    const rows = (
      await client.query<{ name: string; finished: boolean; rolledBack: boolean }>(
        `SELECT migration_name AS name, finished_at IS NOT NULL AS finished,
                rolled_back_at IS NOT NULL AS "rolledBack"
           FROM "_prisma_migrations"`,
      )
    ).rows;
    const failed = rows.filter((r) => !r.finished && !r.rolledBack).map((r) => r.name);
    if (failed.length)
      throw new MigrationError(
        `Migration ${failed.join(', ')} failed earlier. Restore the backup taken before the upgrade, or fix what made it fail and mark it as rolled back (hubium migrate resolve --rolled-back ${failed[0]}): the next hubium migrate applies it again.`,
      );
    const done = new Set(rows.filter((r) => r.finished && !r.rolledBack).map((r) => r.name));
    for (const name of bundledMigrations(dir)) {
      if (done.has(name)) continue;
      const script = readFileSync(path.join(dir, name, 'migration.sql'));
      const id = randomUUID();
      await client.query(
        `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count)
         VALUES ($1, $2, $3, now(), 0)`,
        [id, createHash('sha256').update(script).digest('hex'), name],
      );
      try {
        // One simple query, like Prisma: PostgreSQL runs the statements in one implicit
        // transaction, so a failing migration leaves nothing half applied.
        await client.query(script.toString('utf8'));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await client.query(`UPDATE "_prisma_migrations" SET logs = $2 WHERE id = $1`, [
          id,
          message,
        ]);
        throw new MigrationError(`Migration ${name} failed: ${message}`);
      }
      await client.query(
        `UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = 1 WHERE id = $1`,
        [id],
      );
      applied.push(name);
      onApplied(name);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [PRISMA_LOCK]).catch(() => {});
    await client.end().catch(() => {});
  }
}

/**
 * Marks a failed migration as rolled back, as `prisma migrate resolve --rolled-back` does,
 * once its cause is fixed: the next deploy applies it again. A failed migration left
 * nothing behind (it runs in one transaction). False when no such failed migration exists.
 */
export async function markRolledBack(url: string, name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [PRISMA_LOCK]);
    const r = await client.query(
      `UPDATE "_prisma_migrations" SET rolled_back_at = now()
        WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL`,
      [name],
    );
    return (r.rowCount ?? 0) > 0;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [PRISMA_LOCK]).catch(() => {});
    await client.end().catch(() => {});
  }
}
