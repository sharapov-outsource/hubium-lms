import { createDb, type Db, inWriteScope, UnscopedWriteError, withWriteScope } from '@hubium/db';
import { createTestDatabase, type TestDatabase } from '@hubium/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../test/helpers.ts';
import { Permissions } from './access/permissions.ts';
import type { RequestContext } from './context.ts';
import { defineOperation } from './operation.ts';

// The strict guard refuses a write outside a write scope and lets through those of
// operations and of the other scopes, also inside transactions and as raw SQL.

let tdb: TestDatabase;
let db: Db;

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb({ url: tdb.url, max: 2, writeGuard: 'strict' });
});

afterAll(async () => {
  await db?.$disconnect();
  await tdb?.drop();
});

const ctx = (): RequestContext => ({
  db,
  actor: { kind: 'system' },
  perm: new Permissions(db, { kind: 'system' }),
  now: new Date(),
  locale: 'en',
  origin: 'CLI',
});

const setFlag = defineOperation({
  name: 'test.flag.set',
  input: z.object({ value: z.boolean() }),
  handler: async (c, i) => {
    await c.tx.siteSetting.upsert({
      where: { key: 'test.flag' },
      create: { key: 'test.flag', value: i.value },
      update: { value: i.value },
    });
    return i.value;
  },
});

describe('the strict write guard', () => {
  it('refuses writes outside a scope, in a transaction and as raw SQL too', async () => {
    await expect(
      db.siteSetting.create({ data: { key: 'test.loose', value: 1 } }),
    ).rejects.toBeInstanceOf(UnscopedWriteError);
    await expect(
      db.$transaction((tx) => tx.siteSetting.create({ data: { key: 'test.loose', value: 1 } })),
    ).rejects.toThrow(/SiteSetting.create runs outside an operation/);
    await expect(
      db.$executeRaw`UPDATE "SiteSetting" SET "value" = '2' WHERE "key" = 'test.loose'`,
    ).rejects.toBeInstanceOf(UnscopedWriteError);
    expect(await db.siteSetting.count({ where: { key: 'test.loose' } })).toBe(0);
  });

  it('lets reads, notifications and row locks through anywhere', async () => {
    expect(await db.siteSetting.findMany({ where: { key: 'none' } })).toEqual([]);
    await db.$executeRaw`SELECT pg_notify('hubium_test', 'x')`;
    await db.$transaction((tx) => tx.$queryRaw`SELECT 1 FROM "SiteSetting" FOR UPDATE`);
  });

  it("lets an operation's writes through", async () => {
    expect(await setFlag.run(ctx(), { value: true })).toBe(true);
    const row = await db.siteSetting.findUnique({ where: { key: 'test.flag' } });
    expect(row?.value).toBe(true);
  });

  it('lets writes of the other scopes through, and of a client bound to one', async () => {
    await withWriteScope('touch', 'test', () =>
      db.siteSetting.create({ data: { key: 'test.touch', value: 1 } }),
    );
    await withWriteScope('derived', 'test', async () => {
      await db.$executeRaw`UPDATE "SiteSetting" SET "value" = '2' WHERE "key" = 'test.touch'`;
    });
    const auth = inWriteScope(db, 'auth', 'test');
    await auth.siteSetting.delete({ where: { key: 'test.touch' } });
    await auth.$transaction((tx) =>
      tx.siteSetting.create({ data: { key: 'test.auth', value: 1 } }),
    );
    expect(
      await db.siteSetting.count({ where: { key: { in: ['test.touch', 'test.auth'] } } }),
    ).toBe(1);
  });
});
