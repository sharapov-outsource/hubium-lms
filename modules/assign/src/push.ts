import type { ActivityRef, ModuleCtx } from '@hubium/module-sdk';
import type { AssignSettingsT } from './config.ts';
import { effectiveDates } from './dates.ts';
import { flagsFor, gradeReleased, isBlind } from './marking.ts';
import { applyPenalty, latePenalty, lateSeconds } from './penalty.ts';

// The one way assignment grades reach the gradebook: each student's latest grade, less the
// late penalty for the work it grades. The penalty and lateness are kept with the grade so
// the student and the teacher see how the gradebook figure came about. A grade overridden
// in the gradebook stays as it is (the gradebook keeps its override). A grade that is not
// released yet (marking workflow) or still blind leaves the gradebook empty, as Moodle's.

export async function pushGrades(
  ctx: ModuleCtx,
  a: ActivityRef<AssignSettingsT>,
  userIds: string[],
  scale: string[] | null,
) {
  const blind = await isBlind(ctx.db, a);
  const flags = await flagsFor(ctx.db, a, userIds);
  for (const userId of userIds) {
    const g = await ctx.db.assignGrade.findFirst({
      where: { activityId: a.id, userId },
      orderBy: { attemptNumber: 'desc' },
    });
    if (!g) continue;
    // the work graded: the student's own, or their team's, of that attempt
    const sub = await ctx.db.assignSubmission.findFirst({
      where: {
        activityId: a.id,
        attemptNumber: g.attemptNumber,
        OR: [{ userId }, { group: { members: { some: { userId } } }, userId: null }],
      },
      orderBy: { updatedAt: 'desc' },
    });
    const dates = await effectiveDates(ctx.db, a, userId);
    const late = lateSeconds(sub?.submittedAt ?? null, dates.dueAt);
    const percent =
      g.grade === null || scale
        ? 0
        : latePenalty(late, a.settings.latePenaltyPerDay, a.settings.latePenaltyCap);
    await ctx.db.assignGrade.update({
      where: { id: g.id },
      data: { penalty: percent || null, lateSeconds: late || null },
    });
    const raw = g.grade === null ? null : Number(g.grade);
    const released = gradeReleased(a, flags.get(userId)!.workflowState, blind);
    await ctx.grades.setGrades(a.id, [
      released
        ? {
            userId,
            rawGrade: raw === null ? null : applyPenalty(raw, percent),
            feedback: g.feedback,
            gradedById: g.graderId,
          }
        : { userId, rawGrade: null, feedback: null, gradedById: null },
    ]);
    await ctx.completion.recompute(a.id, userId);
  }
}
