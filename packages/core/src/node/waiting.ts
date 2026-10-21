import type { Db, Prisma } from '@hubium/db';
import { isNode } from './config.ts';

/** A node silent this long is taken for one working without a connection. */
const SILENT_MS = 30_000;

/**
 * Since when work done on a local node without a connection may still come: the start of
 * the earliest outage whose journal the cloud has not replayed yet, or the last heartbeat
 * of a node silent now (the cloud learns of its outage only when it is heard again).
 * Closing overdue attempts in the cloud waits for it, so that answers given on the node
 * come first. A node silent longer than NODE_MAX_WAIT_HOURS (default 12) holds nothing up:
 * what it brings later becomes a conflict a teacher may accept. On a node itself nothing
 * waits: it closes its own attempts.
 */
export async function nodeWorkWaitingSince(
  db: Db | Prisma.TransactionClient,
  now = new Date(),
): Promise<Date | null> {
  if (isNode()) return null;
  const maxWaitMs = (Number(process.env.NODE_MAX_WAIT_HOURS) || 12) * 3_600_000;
  const horizon = new Date(now.getTime() - maxWaitMs);
  const [outage, silent] = await Promise.all([
    db.nodeOutage.aggregate({
      where: { syncedAt: null, startedAt: { gt: horizon }, node: { revokedAt: null } },
      _min: { startedAt: true },
    }),
    db.node.aggregate({
      where: {
        revokedAt: null,
        tokenHash: { not: null },
        lastSeenAt: { lt: new Date(now.getTime() - SILENT_MS), gt: horizon },
      },
      _min: { lastSeenAt: true },
    }),
  ]);
  const times = [outage._min.startedAt, silent._min.lastSeenAt].filter((d): d is Date => !!d);
  return times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
}
