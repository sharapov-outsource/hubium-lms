import { z } from 'zod';

// What earns a badge, as Moodle's badge criteria: completing the course or other courses,
// completing activities, a course grade, being awarded by people in some roles, or
// belonging to a cohort; all of the rules, or any one. Pure: the facts about a learner
// are gathered elsewhere.

const ids = z.array(z.string().uuid()).min(1).max(200);
const method = z.enum(['all', 'any']).default('all');

export const BadgeRule = z.discriminatedUnion('kind', [
  /** The badge's own course completed (course badges). */
  z.object({ kind: z.literal('courseCompletion') }),
  /** Other courses completed (site badges). */
  z.object({ kind: z.literal('courses'), courseIds: ids, method }),
  /** Activities of the badge's course completed (passed, for those with a pass mark). */
  z.object({ kind: z.literal('activities'), activityIds: ids, method }),
  /** The course total at least this percent of its maximum. */
  z.object({ kind: z.literal('courseGrade'), minPercent: z.coerce.number().min(0).max(100) }),
  /** Awarded by hand by someone in these roles. */
  z.object({ kind: z.literal('manual'), roleIds: ids, method }),
  /** A member of these cohorts (site badges). */
  z.object({ kind: z.literal('cohort'), cohortIds: ids, method }),
]);
export type BadgeRuleT = z.infer<typeof BadgeRule>;

export const BadgeCriteria = z.object({
  method: z.enum(['all', 'any']).default('all'),
  rules: z.array(BadgeRule).max(20).default([]),
});
export type BadgeCriteriaT = z.infer<typeof BadgeCriteria>;

/** Rules each kind of badge may have. */
export const COURSE_RULES = ['courseCompletion', 'activities', 'courseGrade', 'manual'] as const;
export const SITE_RULES = ['courses', 'manual', 'cohort'] as const;

/** The criteria, or why they cannot be used for a badge of this kind. */
export function checkCriteria(raw: unknown, site: boolean): BadgeCriteriaT {
  const parsed = BadgeCriteria.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const [where, index] = issue?.path ?? [];
    const kind =
      where === 'rules' && typeof index === 'number'
        ? (raw as { rules?: { kind?: unknown }[] }).rules?.[index]?.kind
        : undefined;
    if (issue?.code === 'too_small' && typeof kind === 'string')
      throw new Error(`Choose at least one for the rule ${kind}`);
    throw new Error(`Invalid criteria${typeof kind === 'string' ? ` (rule ${kind})` : ''}`);
  }
  const c = parsed.data;
  const allowed: readonly string[] = site ? SITE_RULES : COURSE_RULES;
  const bad = c.rules.find((r) => !allowed.includes(r.kind));
  if (bad) throw new Error(`A ${site ? 'site' : 'course'} badge cannot have the rule ${bad.kind}`);
  const kinds = c.rules.map((r) => r.kind);
  if (new Set(kinds).size !== kinds.length) throw new Error('Each kind of rule once');
  return c;
}

/** What is known about one learner, as the rules ask. */
export interface BadgeFacts {
  completedCourses: ReadonlySet<string>;
  completedActivities: ReadonlySet<string>;
  /** Course total as a percent of its maximum; null without a grade. */
  courseGradePercent: number | null;
  /** Roles of the people who awarded the badge by hand. */
  markedByRoles: ReadonlySet<string>;
  cohorts: ReadonlySet<string>;
}

const some = (method: 'all' | 'any', list: string[], has: (x: string) => boolean) =>
  method === 'all' ? list.every(has) : list.some(has);

export function ruleMet(rule: BadgeRuleT, facts: BadgeFacts, courseId: string | null): boolean {
  switch (rule.kind) {
    case 'courseCompletion':
      return !!courseId && facts.completedCourses.has(courseId);
    case 'courses':
      return some(rule.method, rule.courseIds, (x) => facts.completedCourses.has(x));
    case 'activities':
      return some(rule.method, rule.activityIds, (x) => facts.completedActivities.has(x));
    case 'courseGrade':
      return facts.courseGradePercent !== null && facts.courseGradePercent >= rule.minPercent;
    case 'manual':
      return some(rule.method, rule.roleIds, (x) => facts.markedByRoles.has(x));
    case 'cohort':
      return some(rule.method, rule.cohortIds, (x) => facts.cohorts.has(x));
  }
}

/** Whether the learner has earned the badge; a badge without rules is earned by no one. */
export function criteriaMet(c: BadgeCriteriaT, facts: BadgeFacts, courseId: string | null) {
  if (!c.rules.length) return false;
  return c.method === 'all'
    ? c.rules.every((r) => ruleMet(r, facts, courseId))
    : c.rules.some((r) => ruleMet(r, facts, courseId));
}
