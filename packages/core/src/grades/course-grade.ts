import type { Db, Prisma } from '@hubium/db';
import { learnerCourseTotal } from './gradebook.ts';

type Tx = Db | Prisma.TransactionClient;

/**
 * The learner's course total as a percentage of its range, as reports show it:
 * (grade − minimum) / (maximum − minimum). Null without a total or a grade. Badges and
 * certificates that ask for a course grade read it here. With `seen`, the total is the one
 * the learner sees (see learnerCourseTotal), for what is shown to them: a certificate prints
 * it, and it gives no grade hidden from them away.
 */
export async function courseGradePercent(
  tx: Tx,
  courseId: string,
  userId: string,
  { seen = false }: { seen?: boolean } = {},
): Promise<number | null> {
  const item = await tx.gradeItem.findFirst({ where: { courseId, kind: 'COURSE' } });
  if (!item) return null;
  const [min, max] = [Number(item.gradeMin), Number(item.gradeMax)];
  if (!(max > min)) return null;
  const grade = seen
    ? await learnerCourseTotal(tx, courseId, userId)
    : (
        await tx.grade.findUnique({
          where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
          select: { finalGrade: true },
        })
      )?.finalGrade;
  if (grade === null || grade === undefined) return null;
  return ((Number(grade) - min) / (max - min)) * 100;
}
