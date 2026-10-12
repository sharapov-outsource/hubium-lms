import { describe, expect, it } from 'vitest';
import { useTestDb } from '../../test/helpers.ts';
import { environmentChecks, prometheusMetrics, recordHeartbeat } from './health.ts';

describe('operations', () => {
  const t = useTestDb();

  it('reports the worker heartbeat, storage and database', async () => {
    const before = await environmentChecks(t.db);
    expect(before.find((c) => c.key === 'worker')).toMatchObject({ status: 'error' });
    await recordHeartbeat(t.db);
    const checks = await environmentChecks(t.db);
    const by = Object.fromEntries(checks.map((c) => [c.key, c]));
    expect(Object.keys(by)).toEqual(
      expect.arrayContaining([
        'database',
        'worker',
        'jobs',
        'storage',
        'smtp',
        'contentOrigin',
        'push',
        'ai',
        'ffmpeg',
      ]),
    );
    expect(by.worker).toMatchObject({ status: 'ok' });
    expect(by.storage).toMatchObject({ status: 'ok' });
    expect(by.database!.detail).toContain('pgvector');
    const stale = await environmentChecks(t.db, new Date(Date.now() + 10 * 60_000));
    expect(stale.find((c) => c.key === 'worker')).toMatchObject({ status: 'error' });
  });

  it('exposes Prometheus metrics', async () => {
    const text = await prometheusMetrics(t.db);
    expect(text).toMatch(/^# HELP hubium_users /m);
    expect(text).toMatch(/^hubium_users \d+$/m);
    expect(text).toMatch(/^hubium_worker_heartbeat_age_seconds \d+$/m);
    for (const line of text.trim().split('\n'))
      expect(line).toMatch(/^(# (HELP|TYPE) \w+ .+|[a-z_0-9]+(\{[^}]*\})? -?\d+(\.\d+)?)$/);
  });
});
