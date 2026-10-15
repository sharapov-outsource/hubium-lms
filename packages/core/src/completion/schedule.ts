import type { Prisma } from '@hubium/db';
import { enqueue } from '../jobs/jobs.ts';

/** Worker job: course progress for everyone enrolled (see recomputeCourseForAll). */
export const COURSE_PROGRESS_JOB = 'completion.course';

/** Counts towards course progress: shown, with completion tracked, not in the recycle bin. */
export const countsTowardsProgress = (a: {
  visibility: string;
  completionMode: string;
  deletedAt: Date | null;
}) => !a.deletedAt && a.visibility === 'SHOWN' && a.completionMode !== 'NONE';

/**
 * Progress is the share of the activities that count, so adding, removing or hiding one, or
 * starting or stopping tracking, changes it for everyone: the course is worked out again in
 * the background, once for a burst of such changes.
 */
export function scheduleCourseProgress(tx: Prisma.TransactionClient, courseId: string) {
  return enqueue(
    COURSE_PROGRESS_JOB,
    { courseId },
    { tx, singletonKey: courseId, singletonSeconds: 60, singletonNextSlot: true },
  );
}
