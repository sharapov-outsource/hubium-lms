import { createDb, type Db } from '@hubium/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { createUser } from '../users/users.ts';
import { createAuth } from './auth.ts';

// Better Auth writes, and so do its hooks (the sign-in records, the lockout count, known
// devices): all of it in the auth write scope, which the strict guard lets through.

describe('Better Auth under the strict write guard', () => {
  const t = useTestDb();
  let db: Db;
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    db = createDb({ url: t.tdb.url, max: 2, writeGuard: 'strict' });
    auth = createAuth({ db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
    const admin = { ...(await ctxFor(t.db, 'admin@test.local')), db };
    await createUser.run(admin, {
      email: 'scoped@example.org',
      username: 'scoped',
      firstName: 'Sco',
      lastName: 'Ped',
      password: 'Right-pass-1',
    });
  });
  afterAll(() => db?.$disconnect());

  it('records a failed and a successful sign-in from a new device', async () => {
    const headers = new Headers({
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    });
    const signIn = (password: string) =>
      auth.api.signInEmail({ body: { email: 'scoped@example.org', password }, headers });
    await expect(signIn('wrong')).rejects.toMatchObject({ statusCode: 401 });
    expect((await signIn('Right-pass-1')).token).toEqual(expect.any(String));
    const user = await db.user.findUniqueOrThrow({ where: { email: 'scoped@example.org' } });
    expect(user.lastLoginAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });
});
