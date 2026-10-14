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

/** Idempotent: safe to run on every deploy. */
export async function seed(db: Db, opts: SeedOptions) {
  await ensureSystemContext(db);
  await syncCapabilities(db);
  await syncSearchLanguages(db);
  invalidatePermissionCaches();

  let adminCreated = false;
  if (!(await hasSiteAdmin(db, opts.adminEmail))) {
    await createUserRecord(db, {
      email: opts.adminEmail,
      username: 'admin',
      firstName: 'Site',
      lastName: 'Admin',
      password: opts.adminPassword,
      isSiteAdmin: true,
      emailVerified: true,
    });
    adminCreated = true;
  }

  const users: Record<string, string> = {};
  if (opts.profile === 'demo') {
    for (const u of demoUsers) {
      const existing = await db.user.findUnique({ where: { email: u.email } });
      const user =
        existing ??
        (await createUserRecord(db, {
          email: u.email,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          password: DEMO_PASSWORD,
          emailVerified: true,
        }));
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
  let demoCourses = false;
  if (opts.profile === 'demo' && opts.courses !== false) {
    const { seedDemoCourses } = await import('./demo-courses.ts');
    demoCourses = (await seedDemoCourses(db, users)).created;
  }
  const embeddings = await seedEmbeddingsFromEnv(db);
  return { adminCreated, demoUsers: Object.keys(users).length, demoCourses, embeddings };
}
