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

/**
 * Of `userIds`, those whose work the viewer may see: everyone, or in separate groups, for a
 * viewer who cannot see all groups, the members of the viewer's groups.
 */
export async function inVisibleGroups(
  db: Pick<Prisma.TransactionClient, 'groupMember'>,
  a: Activity & Pick<ActivityRef, 'groupMode'>,
  viewerId: string,
  canSeeAll: boolean,
  userIds: string[],
): Promise<string[]> {
  const groups = await visibleGroupFilter(db, a, viewerId, canSeeAll);
  if (!groups) return userIds;
  const rows = await db.groupMember.findMany({
    where: { groupId: { in: groups }, userId: { in: userIds } },
    select: { userId: true },
  });
  const seen = new Set(rows.map((r) => r.userId));
  return userIds.filter((id) => seen.has(id));
}
