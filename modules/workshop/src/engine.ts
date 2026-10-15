// The workshop's rules, as Moodle's, without the database: an assessment form of a
// grading strategy turned into a grade, the grade of a submission from its
// assessments, the grade for assessing ("comparison with the best assessment"), and
// the random allocation of reviewers. Pure, so the server, the forms and the tests
// share them.

export const strategies = ['accumulative', 'comments', 'numerrors', 'rubric'] as const;
export type Strategy = (typeof strategies)[number];

export const phases = ['setup', 'submission', 'assessment', 'evaluation', 'closed'] as const;
export type Phase = (typeof phases)[number];

export interface Dimension {
  id: string;
  description: string;
  /** accumulative: the most points; numerrors: unused. */
  maxGrade?: number;
  weight?: number;
  /** numerrors: what "the assertion holds" and "it does not" are called. */
  positive?: string;
  negative?: string;
  /** rubric: the levels with their points. */
  levels?: { id: string; grade: number; definition: string }[];
}

export interface WorkshopForm {
  strategy: Strategy;
  dimensions: Dimension[];
  /** numerrors: the grade (0..100) for a number of weighted errors; missing ones are linear. */
  mapping?: Record<string, number>;
}

/** An assessment filled in: for each dimension a grade, a level or a yes/no, and a comment. */
export type Filling = Record<
  string,
  { grade?: number; levelId?: string; passed?: boolean; comment?: string }
>;

const weightOf = (d: Dimension) => Math.max(0, d.weight ?? 1);
const round5 = (x: number) => Math.round(x * 100_000) / 100_000;

/** What a filling misses or gets wrong for the form, or null. */
export function fillingError(form: WorkshopForm, f: Filling): string | null {
  for (const [i, d] of form.dimensions.entries()) {
    const v = f[d.id];
    const name = `${i + 1}`;
    if (form.strategy === 'comments') {
      if (!v?.comment?.trim()) return `Comment on aspect ${name}`;
    } else if (form.strategy === 'accumulative') {
      const g = v?.grade;
      if (g === undefined || !Number.isFinite(g)) return `Grade criterion ${name}`;
      if (g < 0 || g > (d.maxGrade ?? 0)) return `Criterion ${name} takes 0 to ${d.maxGrade}`;
    } else if (form.strategy === 'numerrors') {
      if (typeof v?.passed !== 'boolean') return `Answer assertion ${name}`;
    } else if (!d.levels?.some((l) => l.id === v?.levelId))
      return `Choose a level for criterion ${name}`;
  }
  return null;
}

/**
 * Each dimension's grade as 0..100 with its weight: what assessments are compared by.
 * Comments have no grades.
 */
export function dimensionGrades(
  form: WorkshopForm,
  f: Filling,
): Record<string, { grade: number; weight: number }> {
  const out: Record<string, { grade: number; weight: number }> = {};
  for (const d of form.dimensions) {
    const v = f[d.id];
    if (form.strategy === 'accumulative' && v?.grade !== undefined && (d.maxGrade ?? 0) > 0)
      out[d.id] = { grade: (v.grade / d.maxGrade!) * 100, weight: weightOf(d) };
    else if (form.strategy === 'numerrors' && typeof v?.passed === 'boolean')
      out[d.id] = { grade: v.passed ? 100 : 0, weight: weightOf(d) };
    else if (form.strategy === 'rubric' && d.levels?.length) {
      const grades = d.levels.map((l) => l.grade);
      const [lo, hi] = [Math.min(...grades), Math.max(...grades)];
      const chosen = d.levels.find((l) => l.id === v?.levelId);
      if (chosen && hi > lo)
        out[d.id] = { grade: ((chosen.grade - lo) / (hi - lo)) * 100, weight: 1 };
    }
  }
  return out;
}

/** The grade (0..100) an assessment gives the submission, by the form's strategy. */
export function assessmentGrade(form: WorkshopForm, f: Filling): number | null {
  switch (form.strategy) {
    case 'comments':
      // comments carry no grade: every assessed submission gets the whole
      return 100;
    case 'accumulative': {
      const dims = Object.values(dimensionGrades(form, f));
      const w = dims.reduce((s, d) => s + d.weight, 0);
      return w > 0 ? round5(dims.reduce((s, d) => s + d.grade * d.weight, 0) / w) : null;
    }
    case 'numerrors': {
      const total = form.dimensions.reduce((s, d) => s + weightOf(d), 0);
      const errors = form.dimensions.reduce(
        (s, d) => s + (f[d.id]?.passed === false ? weightOf(d) : 0),
        0,
      );
      const mapped = form.mapping?.[String(errors)];
      if (mapped !== undefined) return Math.max(0, Math.min(100, mapped));
      return total > 0 ? round5(100 - (errors / total) * 100) : null;
    }
    case 'rubric': {
      // the points placed between the least and the most the rubric gives
      let min = 0;
      let max = 0;
      let got = 0;
      for (const d of form.dimensions) {
        const grades = (d.levels ?? []).map((l) => l.grade);
        if (!grades.length) continue;
        min += Math.min(...grades);
        max += Math.max(...grades);
        got += d.levels!.find((l) => l.id === f[d.id]?.levelId)?.grade ?? Math.min(...grades);
      }
      return max > min ? round5(((got - min) / (max - min)) * 100) : null;
    }
  }
}

/** A submission's grade (0..100): the weighted mean of its assessments' grades. */
export function submissionGrade(assessments: { grade: number | null; weight: number }[]) {
  const rated = assessments.filter((x) => x.grade !== null && x.weight > 0);
  const w = rated.reduce((s, x) => s + x.weight, 0);
  return w > 0 ? round5(rated.reduce((s, x) => s + x.grade! * x.weight, 0) / w) : null;
}

/** How strictly assessments are compared: Moodle's very lax (9) to very strict (1). */
export const comparisons = [9, 7, 5, 3, 1] as const;

export interface Assessed {
  id: string;
  weight: number;
  dims: Record<string, { grade: number; weight: number }>;
}

function distance(
  a: Assessed,
  ref: Record<string, number>,
  variances: Record<string, number>,
  comparison: number,
): number | null {
  let sum = 0;
  let n = 0;
  for (const [dim, { grade, weight }] of Object.entries(a.dims)) {
    const r = ref[dim];
    if (r === undefined) continue;
    n += weight;
    // variances very close to zero are too sensitive to small changes
    const v = Math.max(variances[dim] ?? 0, 0.01);
    if (grade !== r) sum += Math.abs(grade - r) * ((grade - r) ** 2 / (comparison * v)) * weight;
  }
  return n > 0 ? Math.round((sum / n) * 10_000) / 10_000 : null;
}

/**
 * Grades for assessing (0..100) of one submission's assessments, as Moodle's "comparison
 * with the best assessment": the assessments nearest to their weighted mean are the
 * best; each assessment loses what it is away from the nearest best, scaled by the
 * variance of each dimension and the strictness. Null when nothing can be compared.
 */
export function bestEvaluation(
  assessments: Assessed[],
  comparison: number,
): Map<string, number | null> {
  const out = new Map<string, number | null>(assessments.map((a) => [a.id, null]));
  const weighted = assessments.filter((a) => a.weight > 0 && Object.keys(a.dims).length);
  const w = weighted.reduce((s, a) => s + a.weight, 0);
  if (!weighted.length || w <= 0) return out;
  const dims = [...new Set(weighted.flatMap((a) => Object.keys(a.dims)))];
  const mean: Record<string, number> = {};
  const variances: Record<string, number> = {};
  for (const d of dims) {
    const xs = weighted.filter((a) => a.dims[d]);
    const ws = xs.reduce((s, a) => s + a.weight, 0);
    if (ws <= 0) continue;
    mean[d] = xs.reduce((s, a) => s + a.dims[d]!.grade * a.weight, 0) / ws;
    variances[d] = xs.reduce((s, a) => s + a.weight * (a.dims[d]!.grade - mean[d]!) ** 2, 0) / ws;
  }
  const toMean = new Map(weighted.map((a) => [a.id, distance(a, mean, variances, comparison)]));
  const known = [...toMean.values()].filter((d): d is number => d !== null);
  if (!known.length) return out;
  const least = Math.min(...known);
  const best = weighted.filter((a) => toMean.get(a.id) === least);
  for (const a of assessments) {
    let d: number | null = null;
    for (const b of best) {
      const ref = Object.fromEntries(Object.entries(b.dims).map(([k, v]) => [k, v.grade]));
      const x = distance(a, ref, variances, comparison);
      if (x !== null && (d === null || x < d)) d = x;
    }
    if (d !== null) out.set(a.id, round5(Math.max(0, Math.min(100, 100 - d))));
  }
  return out;
}

/** A reviewer's grade for assessing: the mean of their assessments' (0..100). */
export function gradingGrade(grades: (number | null)[]): number | null {
  const xs = grades.filter((g): g is number => g !== null);
  return xs.length ? round5(xs.reduce((s, g) => s + g, 0) / xs.length) : null;
}

export interface Allocatable {
  /** Submission id, by its author. */
  submissions: { id: string; authorId: string; groups: string[] }[];
  reviewers: { id: string; groups: string[] }[];
  /** Pairs already there (kept unless they are to go). */
  existing: { submissionId: string; reviewerId: string }[];
}

/**
 * Random allocation: `count` reviews for each submission (or by each reviewer), never
 * one's own work unless self-assessment is added, never a groupmate's when excluded.
 * Pairs go to whoever has fewest so far, so the work spreads evenly.
 */
export function randomAllocation(
  input: Allocatable,
  o: {
    count: number;
    per: 'submission' | 'reviewer';
    excludeSameGroup: boolean;
    addSelf: boolean;
    keepExisting: boolean;
  },
  shuffle: <T>(xs: T[]) => T[],
): { submissionId: string; reviewerId: string }[] {
  const pairs = new Set(
    (o.keepExisting ? input.existing : []).map((p) => `${p.submissionId}|${p.reviewerId}`),
  );
  const load = new Map<string, number>();
  const got = new Map<string, number>();
  for (const key of pairs) {
    const [s, r] = key.split('|') as [string, string];
    got.set(s, (got.get(s) ?? 0) + 1);
    load.set(r, (load.get(r) ?? 0) + 1);
  }
  const added: { submissionId: string; reviewerId: string }[] = [];
  const add = (s: string, r: string) => {
    pairs.add(`${s}|${r}`);
    got.set(s, (got.get(s) ?? 0) + 1);
    load.set(r, (load.get(r) ?? 0) + 1);
    added.push({ submissionId: s, reviewerId: r });
  };
  const allowed = (
    sub: Allocatable['submissions'][number],
    rev: Allocatable['reviewers'][number],
  ) =>
    sub.authorId !== rev.id &&
    !pairs.has(`${sub.id}|${rev.id}`) &&
    !(o.excludeSameGroup && sub.groups.some((g) => rev.groups.includes(g)));
  const reviewers = shuffle(input.reviewers);
  const submissions = shuffle(input.submissions);
  if (o.per === 'submission') {
    for (let round = 0; round < o.count; round++)
      for (const sub of submissions) {
        if ((got.get(sub.id) ?? 0) >= o.count) continue;
        const pick = reviewers
          .filter((r) => allowed(sub, r))
          .sort((x, y) => (load.get(x.id) ?? 0) - (load.get(y.id) ?? 0))[0];
        if (pick) add(sub.id, pick.id);
      }
  } else {
    for (let round = 0; round < o.count; round++)
      for (const rev of reviewers) {
        if ((load.get(rev.id) ?? 0) >= o.count) continue;
        const pick = submissions
          .filter((s) => allowed(s, rev))
          .sort((x, y) => (got.get(x.id) ?? 0) - (got.get(y.id) ?? 0))[0];
        if (pick) add(pick.id, rev.id);
      }
  }
  if (o.addSelf)
    for (const sub of input.submissions)
      if (
        !pairs.has(`${sub.id}|${sub.authorId}`) &&
        input.reviewers.some((r) => r.id === sub.authorId)
      )
        add(sub.id, sub.authorId);
  return added;
}
