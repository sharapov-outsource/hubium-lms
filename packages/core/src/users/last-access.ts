import type { Db } from '@hubium/db';

/** How often a user's "last visit" is written at most. */
const RESOLUTION_MS = 60_000;

/**
 * Records that the user is active: the "last visit" shown to their mentors, in messages and
 * to administrators. Written at most once a minute and without touching `updatedAt`.
 */
export async function noteUserAccess(
  db: Db,
  user: { id: string; lastAccessAt: Date | null },
  now = new Date(),
): Promise<void> {
  if (user.lastAccessAt && now.getTime() - user.lastAccessAt.getTime() < RESOLUTION_MS) return;
  await db.$executeRaw`
    UPDATE "User" SET "lastAccessAt" = ${now}
    WHERE id = ${user.id}::uuid
      AND ("lastAccessAt" IS NULL OR "lastAccessAt" < ${new Date(now.getTime() - RESOLUTION_MS)})`;
}
