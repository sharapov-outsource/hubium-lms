import { beforeAll, describe, expect, it } from 'vitest';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { BULK_USERS_JOB, exportUsers, runBulkUsersJob, startBulkUserAction } from './bulk.ts';
import { createUserRecord } from './users.ts';

describe('bulk user actions', () => {
  const t = useTestDb();
  const ids: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const u = await createUserRecord(t.db, {
        username: `bulk${i}`,
        firstName: 'Bulk',
        lastName: `User${i}`,
        password: 'Bulk-pass-1',
      });
      ids.push(u.id);
    }
  });

  it('applies to each person and reports refusals', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const self = ctx.perm.userId!;
    const r = await startBulkUserAction.run(ctx, {
      selection: { ids: [...ids, self] },
      action: { kind: 'suspend' },
    });
    expect(r).toMatchObject({ queued: false, result: { total: 4, done: 3 } });
    expect(r.queued === false && r.result.failed[0]).toMatchObject({
      userId: self,
      error: 'You cannot suspend yourself',
    });
    expect(await t.db.user.count({ where: { id: { in: ids }, status: 'SUSPENDED' } })).toBe(3);

    // everyone a filter finds
    await startBulkUserAction.run(ctx, {
      selection: { filter: { q: 'bulk', status: 'SUSPENDED' } },
      action: { kind: 'activate' },
    });
    expect(await t.db.user.count({ where: { id: { in: ids }, status: 'ACTIVE' } })).toBe(3);

    await startBulkUserAction.run(ctx, {
      selection: { ids },
      action: { kind: 'forcePasswordChange' },
    });
    expect(await t.db.user.count({ where: { id: { in: ids }, mustChangePassword: true } })).toBe(3);
  });

  it('runs large selections in the background and notifies when done', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    capturedJobs.length = 0;
    // straight into the table: hashing 98 passwords takes longer than the test may
    await t.db.user.createMany({
      data: Array.from({ length: 98 }, (_, k) => ({
        email: `bulk${k + 3}@bulk.invalid`,
        username: `bulk${k + 3}`,
        name: `Bulk User${k + 3}`,
        firstName: 'Bulk',
        lastName: `User${k + 3}`,
      })),
    });
    const r = await startBulkUserAction.run(ctx, {
      selection: { filter: { q: 'bulk' } },
      action: { kind: 'unlock' },
    });
    expect(r).toEqual({ queued: true, total: 101 });
    const job = capturedJobs.find((j) => j.name === BULK_USERS_JOB)!;
    const out = await runBulkUsersJob(t.db, job.data as never);
    expect(out).toEqual({ done: 101, failed: 0 });
    const n = await t.db.notification.findFirstOrThrow({
      where: { userId: ctx.perm.userId!, type: 'admin.bulkDone' },
    });
    expect(n.body).toContain('101');
  });

  it('exports in the columns of the CSV upload', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const csv = (await exportUsers(ctx, { ids: ids.slice(0, 2) }, 'csv')) as string;
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('username,email,firstname,lastname,lang,status,lastlogin');
    expect(lines[1]).toBe('bulk0,,Bulk,User0,,active,');
    expect(lines).toHaveLength(3);
  });
});
