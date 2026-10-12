import type { Db, Prisma } from '@hubium/db';

/** Active participants of a course (optionally one group). */
export async function activeCourseUserIds(
  db: Db | Prisma.TransactionClient,
  courseId: string,
  opts: { groupId?: string | null; now?: Date } = {},
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const rows = await db.enrolment.findMany({
    where: {
      courseId,
      status: 'ACTIVE',
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
      user: {
        status: 'ACTIVE',
        ...(opts.groupId ? { groupMembers: { some: { groupId: opts.groupId } } } : {}),
      },
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  return rows.map((r) => r.userId);
}
