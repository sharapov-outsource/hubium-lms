import path from 'node:path';
import { parseArgs } from 'node:util';
import { environmentChecks, getEnv } from '@hubium/core';
import { checkDatabase, type DbCheck, type DbReport } from '@hubium/db/doctor';
import type { Io } from './main.ts';
import { UsageError } from './main.ts';
import { line, migrationsDir, type Status, withDb } from './system.ts';

// `hubium doctor`: the configuration, the database (also an empty one, before installing)
// and, once migrated, the checks of Administration → Environment.

interface Check {
  key: string;
  status: Status;
  detail: string;
  fix?: string;
}

function envChecks(): Check[] {
  const out: Check[] = [];
  try {
    const env = getEnv();
    out.push({ key: 'environment', status: 'ok', detail: `APP_URL ${env.APP_URL}` });
    if (env.STORAGE_DRIVER === 'fs' && !path.isAbsolute(process.env.STORAGE_FS_ROOT ?? ''))
      out.push({
        key: 'storage root',
        status: 'warn',
        detail: 'STORAGE_FS_ROOT is not an absolute path; web and worker may not share files',
      });
    if (env.STORAGE_DRIVER === 's3' && !(env.S3_ACCESS_KEY && env.S3_SECRET_KEY))
      out.push({
        key: 'storage',
        status: 'error',
        detail: 'S3_ACCESS_KEY and S3_SECRET_KEY are required',
      });
  } catch (e) {
    out.push({ key: 'environment', status: 'error', detail: (e as Error).message });
  }
  return out;
}

function fromDb(c: DbCheck): Check {
  return c.fix ? { ...c } : { key: c.key, status: c.status, detail: c.detail };
}

export async function doctorCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  });
  const scope = positionals[0] ?? 'all';
  if (scope !== 'all' && scope !== 'db') throw new UsageError(`Unknown check "${scope}".`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new UsageError('DATABASE_URL is not set.');

  const checks: Check[] = scope === 'all' ? envChecks() : [];
  const report: DbReport = await checkDatabase(url, { migrationsDir: migrationsDir() });
  checks.push(...report.checks.map(fromDb));
  const migrated = report.state === 'hubium' && !report.pending.length && !report.failed.length;
  if (
    scope === 'all' &&
    migrated &&
    !checks.some((c) => c.key === 'environment' && c.status === 'error')
  ) {
    const services = await withDb((db) => environmentChecks(db));
    for (const c of services) {
      if (c.key === 'database') continue;
      // right after installing, the worker may simply not have started yet (it creates the
      // job tables and sends the heartbeat)
      const early = (c.key === 'worker' || c.key === 'jobs') && c.status === 'error';
      const status = early ? 'warn' : c.status;
      checks.push({ key: c.key, status, detail: c.detail });
    }
  }

  const errors = checks.filter((c) => c.status === 'error').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  if (values.json) {
    io.out(
      JSON.stringify({
        state: report.state,
        pending: report.pending,
        failed: report.failed,
        checks,
      }),
    );
  } else {
    for (const c of checks) {
      io.out(line(c.status, c.key, c.detail));
      if (c.fix) io.out(`       fix: ${c.fix}`);
    }
    io.out(
      errors
        ? `${errors} problem(s) to fix.`
        : warnings
          ? `No errors, ${warnings} warning(s).`
          : 'Everything is in order.',
    );
  }
  return errors ? 1 : warnings ? 2 : 0;
}
