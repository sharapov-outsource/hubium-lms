import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// Checks a PostgreSQL database before Hubium is installed on it or upgraded (`hubium doctor
// db`, install-hubium.sh): plain SQL over `pg`, so it also works on an empty database and
// never changes anything. Errors say what to fix; `fix` holds SQL for the DBA when it helps.

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface DbCheck {
  key: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DbReport {
  /** empty: a new installation; hubium: Hubium's own; foreign: someone else's tables. */
  state: 'unreachable' | 'empty' | 'hubium' | 'foreign';
  checks: DbCheck[];
  applied: string[];
  pending: string[];
  failed: string[];
}

export const MIN_SERVER_VERSION = 160000;
/** Extensions the migrations create, with the lowest version that works. */
export const REQUIRED_EXTENSIONS: Record<string, string> = {
  vector: '0.5.0',
  citext: '0',
  pg_trgm: '0',
  unaccent: '0',
};

/** Migration names bundled with this build: the directories holding a migration.sql. */
export function bundledMigrations(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(path.join(dir, name, 'migration.sql')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function versionAtLeast(have: string, want: string): boolean {
  const a = have.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const b = want.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A connection string without its password, for messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(invalid URL)';
  }
}

export async function checkDatabase(
  url: string,
  opts: { migrationsDir: string; timeoutMs?: number },
): Promise<DbReport> {
  const report: DbReport = {
    state: 'unreachable',
    checks: [],
    applied: [],
    pending: [],
    failed: [],
  };
  const add = (key: string, status: CheckStatus, detail: string, fix?: string) =>
    report.checks.push(fix ? { key, status, detail, fix } : { key, status, detail });
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: opts.timeoutMs ?? 5000,
    query_timeout: opts.timeoutMs ?? 5000,
  });
  try {
    await client.connect();
  } catch (e) {
    add('connect', 'error', `Cannot connect to ${redactUrl(url)}: ${(e as Error).message}`);
    return report;
  }
  try {
    const one = async <T>(sql: string, values: unknown[] = []) =>
      (await client.query(sql, values)).rows[0] as T;
    const info = await one<{
      version: string;
      num: string;
      encoding: string;
      db: string;
      user: string;
      superuser: boolean;
      dbCreate: boolean;
      schemaCreate: boolean;
    }>(`SELECT current_setting('server_version') AS version,
              current_setting('server_version_num') AS num,
              pg_encoding_to_char(d.encoding) AS encoding,
              current_database() AS db, current_user AS user,
              r.rolsuper AS superuser,
              has_database_privilege(current_database(), 'CREATE') AS "dbCreate",
              has_schema_privilege('public', 'CREATE') AS "schemaCreate"
         FROM pg_database d, pg_roles r
        WHERE d.datname = current_database() AND r.rolname = current_user`);
    add('connect', 'ok', `${info.user}@${info.db}`);
    if (Number(info.num) >= MIN_SERVER_VERSION) add('version', 'ok', `PostgreSQL ${info.version}`);
    else add('version', 'error', `PostgreSQL ${info.version}; Hubium needs 16 or newer`);
    if (info.encoding === 'UTF8') add('encoding', 'ok', 'UTF8');
    else
      add(
        'encoding',
        'error',
        `The database encoding is ${info.encoding}; Hubium needs UTF8`,
        `CREATE DATABASE ${quoteIdent(info.db)} ENCODING 'UTF8' TEMPLATE template0;`,
      );

    // Extensions: installed, or creatable by this role (trusted ones need CREATE on the
    // database), or a superuser has to create them first.
    const names = Object.keys(REQUIRED_EXTENSIONS);
    const rows = (
      await client.query<{
        name: string;
        version: string;
        installed: boolean;
        trusted: boolean;
        superuser: boolean;
        default_version: string;
      }>(
        `SELECT v.name, v.version, v.installed, v.trusted, v.superuser, a.default_version
           FROM pg_available_extension_versions v
           JOIN pg_available_extensions a ON a.name = v.name
          WHERE v.name = ANY($1) AND (v.installed OR v.version = a.default_version)`,
        [names],
      )
    ).rows;
    for (const name of names) {
      const versions = rows.filter((r) => r.name === name);
      const installed = versions.find((r) => r.installed);
      const candidate = installed ?? versions[0];
      const min = REQUIRED_EXTENSIONS[name]!;
      if (!candidate) {
        add(
          `extension:${name}`,
          'error',
          name === 'vector'
            ? 'pgvector is not installed on the server (package postgresql-<version>-pgvector)'
            : `The ${name} extension is not available on the server (PostgreSQL contrib)`,
        );
        continue;
      }
      if (!versionAtLeast(candidate.version, min)) {
        add(
          `extension:${name}`,
          'error',
          `${name} ${candidate.version} is too old; ${min} or newer is needed`,
          installed ? `ALTER EXTENSION ${quoteIdent(name)} UPDATE;` : undefined,
        );
        continue;
      }
      if (installed) {
        add(`extension:${name}`, 'ok', `${name} ${installed.version} installed`);
        continue;
      }
      const canCreate =
        info.superuser || ((candidate.trusted || !candidate.superuser) && info.dbCreate);
      if (canCreate) add(`extension:${name}`, 'ok', `${name} ${candidate.version} will be created`);
      else
        add(
          `extension:${name}`,
          'error',
          `${info.user} cannot create the ${name} extension; a superuser has to`,
          `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name)};  -- in database ${info.db}`,
        );
    }
    if (info.schemaCreate) add('schema', 'ok', 'CREATE on schema public');
    else
      add(
        'schema',
        'error',
        `${info.user} cannot create tables in schema public`,
        `GRANT CREATE ON SCHEMA public TO ${quoteIdent(info.user)};`,
      );

    // Whose database is it?
    const bundled = bundledMigrations(opts.migrationsDir);
    const hasTable = await one<{ t: string | null }>(
      `SELECT to_regclass('public._prisma_migrations')::text AS t`,
    );
    if (hasTable.t) {
      report.state = 'hubium';
      const applied = (
        await client.query<{ name: string; finished: boolean; rolledBack: boolean }>(
          `SELECT migration_name AS name, finished_at IS NOT NULL AS finished,
                  rolled_back_at IS NOT NULL AS "rolledBack"
             FROM _prisma_migrations ORDER BY migration_name`,
        )
      ).rows;
      report.applied = applied.filter((m) => m.finished && !m.rolledBack).map((m) => m.name);
      report.failed = applied.filter((m) => !m.finished && !m.rolledBack).map((m) => m.name);
      report.pending = bundled.filter((m) => !report.applied.includes(m));
      const unknown = report.applied.filter((m) => !bundled.includes(m));
      if (report.failed.length)
        add(
          'migrations',
          'error',
          `Migration ${report.failed.join(', ')} failed; restore the backup taken before the upgrade, or fix the database and mark it with prisma migrate resolve`,
        );
      else if (unknown.length)
        add(
          'migrations',
          'error',
          `The database is newer than this Hubium version (it has ${unknown.at(-1)}); install that version or newer`,
        );
      else if (report.pending.length)
        add('migrations', 'ok', `Hubium database; ${report.pending.length} migration(s) to apply`);
      else add('migrations', 'ok', 'Hubium database, up to date');
    } else {
      const tables = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      report.pending = bundled;
      if (tables.n > 0) {
        report.state = 'foreign';
        add(
          'migrations',
          'error',
          `The database has ${tables.n} table(s) but is not a Hubium database; use an empty one`,
        );
      } else {
        report.state = 'empty';
        add('migrations', 'ok', `Empty database; ${bundled.length} migration(s) to apply`);
      }
    }
    return report;
  } catch (e) {
    add('query', 'error', (e as Error).message);
    return report;
  } finally {
    await client.end().catch(() => {});
  }
}
