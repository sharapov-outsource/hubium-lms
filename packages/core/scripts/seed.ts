import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const { createDb } = await import('@hubium/db');
const { registerModules } = await import('../src/modules/registry.ts');
const { contentModules } = await import('@hubium/mod-content/server');
const { assignModules } = await import('@hubium/mod-assign/server');
const { quizModules } = await import('@hubium/mod-quiz/server');
const { forumModules } = await import('@hubium/mod-forum/server');
const { videoModules } = await import('@hubium/mod-video/server');
const { livesessionModules } = await import('@hubium/mod-livesession/server');
const { scormModules } = await import('@hubium/mod-scorm/server');
const { ltiModules } = await import('@hubium/mod-lti/server');
await import('../src/bootstrap.ts');
registerModules([
  ...contentModules,
  ...assignModules,
  ...quizModules,
  ...forumModules,
  ...videoModules,
  ...livesessionModules,
  ...scormModules,
  ...ltiModules,
] as never);
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
