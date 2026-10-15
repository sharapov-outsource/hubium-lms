import type { Db } from '@hubium/db';
import { getSetting } from '../settings/settings.ts';

const BATCH = 10_000;

/**
 * Cron (daily): events older than the site keeps them (eventlog.retentionDays), removed a
 * batch at a time so that a long backlog does not hold one huge delete.
 */
export async function pruneEventLog(db: Db, now = new Date()): Promise<number> {
  const days = await getSetting(db, 'eventlog.retentionDays');
  if (!days) return 0;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  let deleted = 0;
  for (;;) {
    const n = await db.$executeRaw`
      DELETE FROM "EventLog"
       WHERE id IN (SELECT id FROM "EventLog" WHERE "createdAt" < ${cutoff} LIMIT ${BATCH})`;
    deleted += n;
    if (n < BATCH) return deleted;
  }
}
