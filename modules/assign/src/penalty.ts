// The late penalty: a percentage of the grade for every started day after the due date,
// up to a cap. Grades on a scale take no penalty (a scale has no fractions of a grade).

const DAY = 86_400;

/** The penalty in percent for work handed in `lateSeconds` after its due date. */
export function latePenalty(lateSeconds: number, perDay: number, cap: number): number {
  if (lateSeconds <= 0 || perDay <= 0) return 0;
  const days = Math.ceil(lateSeconds / DAY);
  return Math.min(Math.max(0, cap), perDay * days);
}

/** A grade less a penalty in percent. */
export function applyPenalty(grade: number, percent: number): number {
  return Math.round(grade * (1 - percent / 100) * 1e5) / 1e5;
}

/** How late work handed in at `submittedAt` is for a due date, in seconds (0 when on time). */
export function lateSeconds(submittedAt: Date | null, dueAt: Date | null): number {
  if (!submittedAt || !dueAt) return 0;
  return Math.max(0, Math.floor((submittedAt.getTime() - dueAt.getTime()) / 1000));
}
