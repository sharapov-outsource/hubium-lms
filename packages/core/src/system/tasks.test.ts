import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { getBoss, stopBoss } from '../jobs/jobs.ts';
import { retryTaskRun, runTaskNow, scheduledTasks, taskLog, taskOverview } from './tasks.ts';

describe('Administration → Tasks', () => {
  const t = useTestDb();
  let boss: PgBoss;

  beforeAll(async () => {
    // a real pg-boss in the test database: its tables are what the page reads
    boss = await getBoss({ connectionString: t.tdb.url });
  });
  afterAll(() => stopBoss());

  /** Runs one job of `name` the way the worker does, failing it with `error`. */
  async function runOnce(name: string, error?: string) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name);
    const id = (await boss.send(name, {}, { retryLimit: 0 }))!;
    const [job] = await boss.fetch(name);
    expect(job?.id).toBe(id);
    if (error) await boss.fail(name, id, { message: error });
    else await boss.complete(name, id, { deleted: 3 });
    return id;
  }

  it('lists scheduled tasks with their last run, and the log of the last 30 days', async () => {
    expect(scheduledTasks().find((x) => x.name === 'email.digest')).toEqual({
      name: 'email.digest',
      cron: '0 * * * *',
      module: null,
    });
    await runOnce('email.digest');
    const failedId = await runOnce('files.gc', 'Storage is unreachable');

    const admin = await ctxFor(t.db, 'admin@test.local');
    const overview = await taskOverview(admin);
    const digest = overview.find((x) => x.name === 'email.digest')!;
    expect(digest.last).toMatchObject({ state: 'completed', error: null });
    expect(digest.last!.durationMs).toBeGreaterThanOrEqual(0);
    expect(digest.lastFailure).toBeNull();
    expect(overview.find((x) => x.name === 'files.gc')!.lastFailure).toMatchObject({
      id: failedId,
      state: 'failed',
      error: 'Storage is unreachable',
    });
    expect(overview.find((x) => x.name === 'enrol.expire')!.last).toBeNull();

    const failed = await taskLog(admin, { state: 'failed' });
    expect(failed.items.map((r) => r.id)).toEqual([failedId]);
    expect((await taskLog(admin, { name: 'email.digest' })).total).toBe(1);
    expect((await taskLog(admin, {})).names).toEqual(
      expect.arrayContaining(['email.digest', 'files.gc']),
    );

    // a failed run goes back to the queue; a scheduled task can be queued now
    await retryTaskRun(admin, { name: 'files.gc', id: failedId });
    expect((await boss.getJobById('files.gc', failedId))?.state).toBe('retry');
    await expect(retryTaskRun(admin, { name: 'files.gc', id: failedId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    capturedJobs.length = 0;
    await runTaskNow(admin, 'files.gc');
    expect(capturedJobs.map((j) => j.name)).toEqual(['files.gc']);
    await expect(runTaskNow(admin, 'email.send')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const { id: teacherId } = await t.db.user.findUniqueOrThrow({ where: { username: 'teacher' } });
    const teacher = await ctxFor(t.db, teacherId);
    await expect(taskOverview(teacher)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
