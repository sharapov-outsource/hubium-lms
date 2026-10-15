import type { RequestContext } from '../context.ts';

/** Groups the user belongs to in the course; null when they can see all groups. */
export async function visibleGroupIds(
  ctx: RequestContext,
  courseId: string,
): Promise<string[] | null> {
  if (await ctx.perm.can('group:accessall', courseId)) return null;
  const rows = await ctx.db.groupMember.findMany({
    where: { userId: ctx.perm.userId ?? '', group: { courseId } },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/**
 * In a course with separate groups, the groups a user without `group:accessall` belongs
 * to: the only ones whose members they may see. Null when they may see every group.
 */
export async function separateGroupsOf(
  ctx: RequestContext,
  courseId: string,
): Promise<string[] | null> {
  const course = await ctx.db.course.findUnique({
    where: { id: courseId },
    select: { groupMode: true },
  });
  if (course?.groupMode !== 'SEPARATE') return null;
  return visibleGroupIds(ctx, courseId);
}
