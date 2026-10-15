// Fails when the migrated database and the Prisma schema differ, or when an index made by
// hand in a migration (raw-indexes.mjs) is missing: Prisma does not know those, so the
// diff alone would not notice a migration that dropped one.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { RAW_INDEXES } from './raw-indexes.mjs';

// as prisma.config.ts: the monorepo keeps one .env at the root
loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const sql = execFileSync(
  'prisma',
  ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema', '--script'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const statements = sql
  .split(';')
  .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean)
  .filter((s) => !RAW_INDEXES.some((name) => s === `DROP INDEX "${name}"`));
if (statements.length) {
  console.error('Schema drift between migrations and prisma/schema:\n');
  console.error(statements.join(';\n\n'));
  process.exit(2);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query('SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)', [
  RAW_INDEXES,
]);
await client.end();
const missing = RAW_INDEXES.filter((name) => !rows.some((r) => r.indexname === name));
if (missing.length) {
  console.error(`Indexes made by hand are missing: ${missing.join(', ')}`);
  process.exit(2);
}
console.log('No schema drift.');
