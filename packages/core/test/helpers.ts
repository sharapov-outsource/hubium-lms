import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

import type { Db } from '@hubium/db';
import { createTestDatabase, type TestDatabase } from '@hubium/db/testing';
import { assignModules } from '@hubium/mod-assign/server';
import { contentModules } from '@hubium/mod-content/server';
import { quizModules } from '@hubium/mod-quiz/server';
import { afterAll, beforeAll } from 'vitest';
import {
  invalidatePermissionCaches,
  loadUserAccess,
  Permissions,
} from '../src/access/permissions.ts';
import type { Actor, RequestContext } from '../src/context.ts';
import { registerModules } from '../src/modules/registry.ts';
import { seed } from '../src/seed/seed.ts';
import '../src/bootstrap.ts';

registerModules([...contentModules, ...assignModules, ...quizModules] as never);

import { invalidateSettingsCache } from '../src/settings/settings.ts';

/** Fresh seeded database per test file. */
export function useTestDb(opts: { profile?: 'minimal' | 'demo' } = {}) {
  const state = {} as { tdb: TestDatabase; db: Db };
  beforeAll(async () => {
    state.tdb = await createTestDatabase();
    state.db = state.tdb.db;
    invalidatePermissionCaches();
    invalidateSettingsCache();
    await seed(state.db, {
      profile: opts.profile ?? 'demo',
      courses: false,
      adminEmail: 'admin@test.local',
      adminPassword: 'Admin12345!',
    });
  });
  afterAll(async () => {
    invalidatePermissionCaches();
    invalidateSettingsCache();
    await state.tdb?.drop();
  });
  return state;
}

export async function ctxFor(db: Db, userIdOrEmail: string | 'system'): Promise<RequestContext> {
  if (userIdOrEmail === 'system') {
    return {
      db,
      actor: { kind: 'system' },
      perm: new Permissions(db, { kind: 'system' }),
      now: new Date(),
      locale: 'en',
      origin: 'CLI',
    };
  }
  const user = await db.user.findFirstOrThrow({
    where: userIdOrEmail.includes('@') ? { email: userIdOrEmail } : { id: userIdOrEmail },
  });
  invalidatePermissionCaches();
  const access = await loadUserAccess(db, user);
  const actor: Actor = { kind: 'user', userId: user.id, isSiteAdmin: user.isSiteAdmin };
  return {
    db,
    actor,
    perm: new Permissions(db, access),
    now: new Date(),
    locale: 'en',
    origin: 'WEB',
  };
}
