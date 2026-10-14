import type { Db } from '@hubium/db';
import { loadUserAccess, Permissions } from '../access/permissions.ts';
import { getAllSettings } from '../settings/settings.ts';

// The two checks behind mentors' access (users/relations.ts), kept light so the gradebook
// can use them without importing the rest.

/** Whether `mentorId` is a mentor or parent of an active `menteeId` while the site allows it. */
export async function isMentorOf(db: Db, mentorId: string, menteeId: string): Promise<boolean> {
  if (!(await getAllSettings(db))['mentors.enabled']) return false;
  const r = await db.userRelation.findUnique({
    where: { mentorId_menteeId: { mentorId, menteeId } },
    select: { mentee: { select: { deletedAt: true, status: true } } },
  });
  return !!r && !r.mentee.deletedAt && r.mentee.status === 'ACTIVE';
}

/** The learner's own permissions: a mentor sees only what the learner may see. */
export async function learnerPermissions(db: Db, userId: string): Promise<Permissions> {
  return new Permissions(db, await loadUserAccess(db, { id: userId, isSiteAdmin: false }));
}
