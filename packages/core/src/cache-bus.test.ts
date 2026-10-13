import { afterAll, describe, expect, it } from 'vitest';
import { useTestDb } from '../test/helpers.ts';
import { startCacheListener, stopCacheListener } from './cache-bus.ts';
import { getAllSettings } from './settings/settings.ts';

describe('cache bus', () => {
  const t = useTestDb({ profile: 'minimal' });
  afterAll(stopCacheListener);

  it('another process changing a setting invalidates this process cache', async () => {
    await startCacheListener(t.tdb.url);
    expect((await getAllSettings(t.db))['site.name']).toBe('Hubium LMS');
    // Simulate a write from another instance: raw SQL + NOTIFY, no local invalidation.
    await t.db
      .$executeRaw`INSERT INTO "SiteSetting"(key, value, "updatedAt") VALUES ('site.name', '"Школа"', now())`;
    expect((await getAllSettings(t.db))['site.name']).toBe('Hubium LMS'); // still cached
    await t.db.$executeRaw`SELECT pg_notify('hubium_cache', 'settings')`;
    await expect
      .poll(async () => (await getAllSettings(t.db))['site.name'], { timeout: 3000 })
      .toBe('Школа');
  });
});
