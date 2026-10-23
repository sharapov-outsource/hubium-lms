import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const { createDb, withWriteScope } = await import('@hubium/db');
const { registerModules } = await import('../src/modules/registry.ts');
const { serverModules } = await import('@hubium/modules');
await import('../src/bootstrap.ts');
registerModules(serverModules as never);
const { seed } = await import('../src/seed/seed.ts');
const { stopBoss } = await import('../src/jobs/jobs.ts');

const profile = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : (process.env.SEED_PROFILE ?? 'demo');
// a mistyped profile is an error, not the demo with its published passwords
if (profile !== 'minimal' && profile !== 'demo') {
  console.error(`Unknown seed profile "${profile}": use minimal or demo.`);
  process.exit(1);
}
// the well-known development password never reaches a production site
const adminPassword =
  process.env.SEED_ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'Admin12345!');
if (!adminPassword) {
  console.error('Set SEED_ADMIN_PASSWORD: the seed may create the first administrator.');
  process.exit(1);
}

const db = createDb();
try {
  const result = await withWriteScope('system', 'seed', () =>
    seed(db, {
      profile,
      adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@hubium.local',
      adminPassword,
    }),
  );
  console.log('Seed complete:', result);
} finally {
  // activities of the demo queue jobs (course progress): the queue's connections end too
  await stopBoss();
  await db.$disconnect();
}
