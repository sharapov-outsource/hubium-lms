// `pnpm db:migrate:dev --name <change>`: creates the migration for a schema change and
// applies it. Three things `prisma migrate dev` alone gets wrong here:
// - it names a migration by the clock, and some migrations are named for a later date, so
//   a new one could sort before them and run before the tables it changes exist;
// - it drops the indexes made by hand (raw-indexes.mjs), which Prisma does not know;
// - for the same reason, once the migrations are applied it still sees a difference and
//   asks for another migration, so they are applied with `migrate deploy` instead.
// With --create-only the migration is created and left to edit, even empty (a change of
// data only); `pnpm db:migrate` applies it.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_INDEXES } from './raw-indexes.mjs';

const DIR = 'prisma/migrations';
const STAMPED = /^(\d{14})_/;

const args = process.argv.slice(2);
const at = args.indexOf('--name');
const name = at >= 0 ? args[at + 1] : args.find((a) => a.startsWith('--name='))?.slice(7);
if (!name) {
  console.error('Usage: pnpm db:migrate:dev --name <change> [--create-only]');
  process.exit(1);
}
const createOnly = args.includes('--create-only');

const prisma = (...a) => execFileSync('prisma', a, { stdio: 'inherit' });
const stamps = () => readdirSync(DIR).filter((d) => STAMPED.test(d));
const before = new Set(stamps());
prisma('migrate', 'dev', '--create-only', '--name', name);
const created = stamps().filter((d) => !before.has(d));
let folder = created[0];
if (created.length === 1) {
  const file = join(DIR, folder, 'migration.sql');
  const sql = readFileSync(file, 'utf8');
  const kept = RAW_INDEXES.reduce(
    (s, index) => s.replace(new RegExp(`^(?:-- DropIndex\\n)?DROP INDEX "${index}";\\n*`, 'm'), ''),
    sql,
  );
  if (!createOnly && !kept.replace(/^\s*--.*$/gm, '').trim()) {
    rmSync(join(DIR, folder), { recursive: true });
    console.log('No schema change: nothing to migrate.');
    process.exit(0);
  }
  if (kept !== sql) writeFileSync(file, kept);
  const last = [...before].sort().at(-1);
  if (last && folder <= last) {
    // a minute after the last one
    const t = STAMPED.exec(last)[1];
    const next = new Date(
      Date.UTC(
        +t.slice(0, 4),
        +t.slice(4, 6) - 1,
        +t.slice(6, 8),
        +t.slice(8, 10),
        +t.slice(10, 12) + 1,
      ),
    );
    const stamp = `${next.toISOString().replace(/\D/g, '').slice(0, 12)}00`;
    const renamed = folder.replace(STAMPED, `${stamp}_`);
    renameSync(join(DIR, folder), join(DIR, renamed));
    console.log(`Named ${renamed} to come after ${last}`);
    folder = renamed;
  }
}
if (createOnly) {
  if (folder)
    console.log(`Created ${join(DIR, folder, 'migration.sql')}: edit it, then pnpm db:migrate`);
  process.exit(0);
}
prisma('migrate', 'deploy');
prisma('generate');
