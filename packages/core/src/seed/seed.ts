import type { Db } from '@hubium/db';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { ensureSystemContext } from '../access/contexts.ts';
import { invalidatePermissionCaches } from '../access/permissions.ts';
import { syncCapabilities } from '../access/roles.ts';
import { createUserRecord } from '../users/users.ts';

export interface SeedOptions {
  profile: 'minimal' | 'demo';
  adminEmail: string;
  adminPassword: string;
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
] as const;

/** Idempotent: safe to run on every deploy. */
export async function seed(db: Db, opts: SeedOptions) {
  await ensureSystemContext(db);
  await syncCapabilities(db);
  invalidatePermissionCaches();

  let adminCreated = false;
  const existingAdmin = await db.user.findUnique({ where: { email: opts.adminEmail } });
  if (!existingAdmin) {
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
    await db.roleAssignment.upsert({
      where: {
        userId_roleId_contextId_component: {
          userId: users.manager!,
          roleId: manager.id,
          contextId: SYSTEM_CONTEXT_ID,
          component: 'MANUAL',
        },
      },
      create: { userId: users.manager!, roleId: manager.id, contextId: SYSTEM_CONTEXT_ID },
      update: {},
    });
  }
  return { adminCreated, demoUsers: Object.keys(users).length };
}
