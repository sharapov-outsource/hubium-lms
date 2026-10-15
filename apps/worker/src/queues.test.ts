import { describe, expect, it, vi } from 'vitest';
import { dropStaleSchedules, runBatch } from './queues.ts';

describe('worker queues', () => {
  it('settles a batch job by job, so a failure does not repeat the others', async () => {
    const boss = { complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const sent: string[] = [];
    await runBatch(
      boss,
      { name: 'email.send' },
      [
        { id: 'a', data: 1 },
        { id: 'b', data: 2 },
        { id: 'c', data: 3 },
      ],
      async (job) => {
        if (job.id === 'b') throw new Error('mail server down');
        sent.push(job.id);
        return { messageId: job.id };
      },
    );
    expect(sent).toEqual(['a', 'c']);
    expect(boss.complete.mock.calls).toEqual([
      ['email.send', 'a', { messageId: 'a' }],
      ['email.send', 'c', { messageId: 'c' }],
    ]);
    expect(boss.fail.mock.calls).toEqual([['email.send', 'b', { message: 'mail server down' }]]);
  });

  it('removes the schedules of jobs no handler runs on a schedule', async () => {
    const boss = {
      getSchedules: async () => [
        { name: 'files.gc', key: '' },
        { name: 'old.renamed', key: '' },
        { name: 'email.send', key: '' },
      ],
      unschedule: vi.fn(async () => {}),
    };
    const dropped = await dropStaleSchedules(boss, [
      { name: 'files.gc', cron: '17 3 * * *' },
      // still handled, but no longer on a schedule
      { name: 'email.send' },
    ]);
    expect(dropped).toEqual(['old.renamed', 'email.send']);
    expect(boss.unschedule.mock.calls).toEqual([
      ['old.renamed', ''],
      ['email.send', ''],
    ]);
  });
});
