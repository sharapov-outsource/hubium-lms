import { parseArgs } from 'node:util';
import type { Db } from '@hubium/db';
import { deployMigrations } from '@hubium/db/migrate';
import type { Io } from './main.ts';
import { UsageError } from './main.ts';
import { setModules } from './modules.ts';
import { loadApp, migrationsDir, withDb } from './system.ts';

// `hubium migrate`: what every start of a release needs before web and worker run, safe to
// repeat — migrations, the S3 bucket and the idempotent seed (administrator, roles, search
// languages, and with `demo` sample users and courses).

const PROFILES = ['minimal', 'demo', 'none'] as const;
type Profile = (typeof PROFILES)[number];

function profileOf(value: string | undefined, flag: string, allowNone: boolean): Profile {
  const allowed = PROFILES.filter((p) => allowNone || p !== 'none');
  if (!value || !(allowed as readonly string[]).includes(value))
    throw new UsageError(`Choose ${flag} ${allowed.join(', ').replace(/, (?=[^,]*$)/, ' or ')}.`);
  return value as Profile;
}

/** Applies the pending migrations (the same bookkeeping as `prisma migrate deploy`). */
export async function applyMigrations(url: string, io: Io): Promise<void> {
  const applied = await deployMigrations(url, migrationsDir(), (name) =>
    io.out(`Migration applied: ${name}`),
  );
  if (!applied.length) io.out('Migrations: up to date');
}

async function prepareStorage(io: Io): Promise<void> {
  const { fsStorageRoot, getStorage, S3Storage } = await import('@hubium/core/files/storage');
  const storage = getStorage();
  if (storage instanceof S3Storage) {
    const result = await storage.ensureBucket();
    io.out(`Storage: S3 bucket ${process.env.S3_BUCKET ?? 'hubium'} ${result}`);
  } else io.out(`Storage: local files in ${fsStorageRoot()}`);
}

async function runSeed(db: Db, profile: 'minimal' | 'demo', io: Io): Promise<void> {
  await loadApp();
  const { hasSiteAdmin, seed } = await import('@hubium/core/seed/seed');
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@hubium.local';
  let adminPassword = process.env.SEED_ADMIN_PASSWORD ?? '';
  if (!adminPassword && !(await hasSiteAdmin(db, adminEmail))) {
    // a production site never gets the well-known development password
    if (process.env.NODE_ENV === 'production')
      throw new UsageError(
        `Set SEED_ADMIN_PASSWORD: the first administrator (${adminEmail}) is created now.`,
      );
    adminPassword = 'Admin12345!';
  }
  const r = await seed(db, { profile, adminEmail, adminPassword });
  io.out(
    `Seed (${profile}): ${r.adminCreated ? `administrator ${adminEmail} created` : 'administrator exists'}` +
      (profile === 'demo'
        ? `, ${r.demoUsers} demo users${r.demoCourses ? ', demo courses created' : ''}`
        : '') +
      (r.embeddings.status === 'created'
        ? `, embeddings: ${process.env.AI_EMBEDDINGS_MODEL} at ${process.env.AI_EMBEDDINGS_URL}`
        : ''),
  );
  if (r.embeddings.status === 'refused')
    io.err(`AI_EMBEDDINGS_URL is not used: ${r.embeddings.reason}`);
}

export async function migrateCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { seed: { type: 'string' }, 'disable-modules': { type: 'string' } },
  });
  const profile = profileOf(values.seed, '--seed', true);
  const disable = (values['disable-modules'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!process.env.DATABASE_URL) throw new UsageError('DATABASE_URL is not set.');
  await applyMigrations(process.env.DATABASE_URL, io);
  return withDb(async (db) => {
    await prepareStorage(io);
    if (disable.length) {
      const { disabled } = await setModules(db, { disable });
      io.out(`Activity types turned off: ${disabled.join(', ')}`);
    }
    if (profile !== 'none') await runSeed(db, profile, io);
    return 0;
  });
}

export async function seedCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { profile: { type: 'string' } } });
  const profile = profileOf(values.profile, '--profile', false);
  return withDb(async (db) => {
    await runSeed(db, profile as 'minimal' | 'demo', io);
    return 0;
  });
}
