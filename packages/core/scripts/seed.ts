import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const { createDb } = await import('@hubium/db');
const { seed } = await import('../src/seed/seed.ts');

const profile = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : (process.env.SEED_PROFILE ?? 'demo');

const db = createDb();
try {
  const result = await seed(db, {
    profile: profile === 'minimal' ? 'minimal' : 'demo',
    adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@hubium.local',
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'Admin12345!',
  });
  console.log('Seed complete:', result);
} finally {
  await db.$disconnect();
}
