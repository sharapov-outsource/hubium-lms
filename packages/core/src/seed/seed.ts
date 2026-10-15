import type { Db } from '@hubium/db';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { ensureSystemContext } from '../access/contexts.ts';
import { invalidatePermissionCaches } from '../access/permissions.ts';
import { syncCapabilities } from '../access/roles.ts';
import { seedEmbeddingsFromEnv } from '../ai/config.ts';
import { syncSearchLanguages } from '../settings/languages.ts';
import { createUserRecord } from '../users/users.ts';

export interface SeedOptions {
  profile: 'minimal' | 'demo';
  adminEmail: string;
  adminPassword: string;
  /** Demo courses (needs content modules registered). Default true for the demo profile. */
  courses?: boolean;
}

export const DEMO_PASSWORD = 'Demo12345!';

export const demoUsers = [
  {
    username: 'teacher',
    email: 'teacher@hubium.local',
    firstName: 'Анна',
    lastName: 'Преподавателева',
    role: 'teacher',
  },
  {
    username: 'assistant',
    email: 'assistant@hubium.local',
    firstName: 'Олег',
    lastName: 'Ассистентов',
    role: 'assistant',
  },
  {
    username: 'student1',
    email: 'student1@hubium.local',
    firstName: 'Иван',
    lastName: 'Петров',
    role: 'student',
  },
  {
    username: 'student2',
    email: 'student2@hubium.local',
    firstName: 'Мария',
    lastName: 'Сидорова',
    role: 'student',
  },
  {
    username: 'student3',
    email: 'student3@hubium.local',
    firstName: 'Пётр',
    lastName: 'Иванов',
    role: 'student',
  },
  {
    username: 'manager',
    email: 'manager@hubium.local',
    firstName: 'Елена',
    lastName: 'Менеджерова',
    role: 'manager',
  },
  {
    username: 'parent',
    email: 'parent@hubium.local',
    firstName: 'Ольга',
    lastName: 'Петрова',
    role: 'parent',
  },
] as const;

/**
 * Does the site have its administrator? The first one is created only while there is none,
 * so an administrator who changes their email (or the SEED_ADMIN_EMAIL of the installation
 * changing) does not make every later start create another.
 */
export async function hasSiteAdmin(db: Db, email: string): Promise<boolean> {
  const n = await db.user.count({
    where: { OR: [{ email }, { isSiteAdmin: true, deletedAt: null }] },
  });
  return n > 0;
}

/** Marks a site that has had its demo data (not a setting: settings ignore the key). */
const DEMO_SEEDED = 'seed.demo';

/** Whether the demo data was put in already, by this seed or by one from before the mark. */
async function demoSeededBefore(db: Db): Promise<boolean> {
  if (await db.siteSetting.findUnique({ where: { key: DEMO_SEEDED } })) return true;
  const [course, accounts] = await Promise.all([
    db.course.findUnique({ where: { shortName: 'DEMO-PY' }, select: { id: true } }),
    db.user.count({ where: { email: { in: demoUsers.map((u) => u.email) } } }),
  ]);
  return !!course || accounts > 0;
}

/** Idempotent: safe to run on every deploy. */
export async function seed(db: Db, opts: SeedOptions) {
  await ensureSystemContext(db);
  await syncCapabilities(db);
  await syncSearchLanguages(db);
  invalidatePermissionCaches();

  let adminCreated = false;
  if (!(await hasSiteAdmin(db, opts.adminEmail))) {
    await createUserRecord(
      db,
      {
        email: opts.adminEmail,
        username: 'admin',
        firstName: 'Site',
        lastName: 'Admin',
        password: opts.adminPassword,
        isSiteAdmin: true,
        emailVerified: true,
      },
      { passwordPolicy: false },
    );
    adminCreated = true;
  }

  const users: Record<string, string> = {};
  // Demo data comes once. A site tried out with it and then put to work keeps what its
  // administrators deleted deleted, the demo accounts with their published password above
  // all: the seed runs again on every start and upgrade.
  const demo = opts.profile === 'demo' && !(await demoSeededBefore(db));
  if (demo) {
    for (const u of demoUsers) {
      const existing = await db.user.findUnique({ where: { email: u.email } });
      const user =
        existing ??
        (await createUserRecord(
          db,
          {
            email: u.email,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName,
            password: DEMO_PASSWORD,
            emailVerified: true,
          },
          { passwordPolicy: false },
        ));
      users[u.username] = user.id;
    }
    const manager = await db.role.findUniqueOrThrow({ where: { shortName: 'manager' } });
    const assignment = { userId: users.manager!, roleId: manager.id, contextId: SYSTEM_CONTEXT_ID };
    if (!(await db.roleAssignment.findFirst({ where: assignment })))
      await db.roleAssignment.create({ data: assignment });
    // student1's mother; she sees his progress once mentors are turned on in the settings
    await db.userRelation.upsert({
      where: { mentorId_menteeId: { mentorId: users.parent!, menteeId: users.student1! } },
      create: { mentorId: users.parent!, menteeId: users.student1!, kind: 'PARENT' },
      update: {},
    });
  }
  // the embedding endpoint from the environment comes before the demo, whose AI setup would
  // otherwise take the built-in hash embeddings and index its course with them
  const embeddings = await seedEmbeddingsFromEnv(db);
  let demoCourses = false;
  if (demo && opts.courses !== false) {
    const { seedDemoCourses } = await import('./demo-courses.ts');
    demoCourses = (await seedDemoCourses(db, users)).created;
  }
  if (demo)
    await db.siteSetting.upsert({
      where: { key: DEMO_SEEDED },
      create: { key: DEMO_SEEDED, value: { at: new Date().toISOString() } },
      update: {},
    });
  return { adminCreated, demoUsers: Object.keys(users).length, demoCourses, embeddings };
}
