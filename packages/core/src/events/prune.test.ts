import { describe, expect, it } from 'vitest';
import { useTestDb } from '../../test/helpers.ts';
import { setSettings } from '../settings/settings.ts';
import { pruneEventLog } from './prune.ts';

describe('the event log', () => {
  const t = useTestDb();

  it('keeps events for as long as the site says, and all of them with 0', async () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const event = (createdAt: Date) => ({ name: 'test.prune', origin: 'CLI' as const, createdAt });
    await t.db.eventLog.createMany({
      data: [event(days(400)), event(days(200)), event(days(1))],
    });
    const left = () => t.db.eventLog.count({ where: { name: 'test.prune' } });
    await setSettings(t.db, { 'eventlog.retentionDays': 0 });
    expect(await pruneEventLog(t.db)).toBe(0);
    expect(await left()).toBe(3);
    await setSettings(t.db, { 'eventlog.retentionDays': 365 });
    await pruneEventLog(t.db);
    expect(await left()).toBe(2);
    await setSettings(t.db, { 'eventlog.retentionDays': 30 });
    await pruneEventLog(t.db);
    expect(await left()).toBe(1);
  });
});
