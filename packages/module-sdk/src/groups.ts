import type { Prisma } from '@hubium/db';
import type { ActivityRef } from './index.ts';

// Group mode helpers shared by activity modules. An activity's groups are those of its
// grouping when it has one, otherwise every group of the course.

type Activity = Pick<ActivityRef, 'courseId' | 'groupingId'>;

/** Prisma filter for the activity's groups. */
export function groupsWhere(a: Activity) {
  return {
    courseId: a.courseId,
    ...(a.groupingId ? { groupings: { some: { groupingId: a.groupingId } } } : {}),
  };
}

/** The user's groups among the activity's groups. */
export async function userGroupIds(
  db: Pick<Prisma.TransactionClient, 'groupMember'>,
  a: Activity,
  userId: string,
): Promise<string[]> {
  const rows = await db.groupMember.findMany({
    where: { userId, group: groupsWhere(a) },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/**
 * Groups whose work the user may see. Separate groups limit those who cannot see all
 * groups (`canSeeAll`: e.g. a teacher or moderator) to their own; `null` means no limit.
 */
export async function visibleGroupFilter(
  db: Pick<Prisma.TransactionClient, 'groupMember'>,
  a: Activity & Pick<ActivityRef, 'groupMode'>,
  userId: string,
  canSeeAll: boolean,
): Promise<string[] | null> {
  if (a.groupMode !== 'SEPARATE' || canSeeAll) return null;
  return userGroupIds(db, a, userId);
}
