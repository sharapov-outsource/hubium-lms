import type { Db, Prisma } from '@hubium/db';

type Tx = Db | Prisma.TransactionClient;

/**
 * The learner's course total as a percentage of its range, as reports show it:
 * (grade − minimum) / (maximum − minimum). Null without a total or a grade. Badges and
 * certificates that ask for a course grade read it here.
 */
export async function courseGradePercent(
  tx: Tx,
  courseId: string,
  userId: string,
): Promise<number | null> {
  const item = await tx.gradeItem.findFirst({ where: { courseId, kind: 'COURSE' } });
  if (!item) return null;
  const [min, max] = [Number(item.gradeMin), Number(item.gradeMax)];
  if (!(max > min)) return null;
  const g = await tx.grade.findUnique({
    where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
    select: { finalGrade: true },
  });
  if (g?.finalGrade === null || g?.finalGrade === undefined) return null;
  return ((Number(g.finalGrade) - min) / (max - min)) * 100;
}
