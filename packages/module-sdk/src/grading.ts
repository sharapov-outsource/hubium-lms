import { z } from 'zod';

// Advanced grading, as Moodle's: a rubric (criteria with levels, a level chosen for each)
// or a marking guide (criteria with a maximum, a score given for each). Both turn into a
// grade on the activity's range with Moodle's formulas. Pure: the grading form in the
// browser shows the same grade the server stores.

export const gradingMethods = ['simple', 'rubric', 'guide'] as const;
export type GradingMethod = (typeof gradingMethods)[number];

const id = z.string().min(1).max(64);

export const Rubric = z.object({
  criteria: z
    .array(
      z.object({
        id,
        description: z.string().trim().min(1).max(2000),
        levels: z
          .array(
            z.object({
              id,
              score: z.number().min(-1000).max(1000),
              definition: z.string().trim().max(2000).default(''),
            }),
          )
          .min(1)
          .max(20),
      }),
    )
    .min(1)
    .max(50),
  /** A grade of 0 rubric points is the lowest grade, whatever the least levels are worth. */
  lockZeroPoints: z.boolean().default(true),
});
export type Rubric = z.output<typeof Rubric>;

export const Guide = z.object({
  criteria: z
    .array(
      z.object({
        id,
        shortName: z.string().trim().min(1).max(255),
        /** Shown to students. */
        descriptionStudents: z.string().max(2000).default(''),
        /** Shown to markers only. */
        descriptionMarkers: z.string().max(2000).default(''),
        maxScore: z.number().positive().max(1000),
      }),
    )
    .min(1)
    .max(50),
});
export type Guide = z.output<typeof Guide>;

/** A rubric filled in: the level chosen for each criterion, with a remark. */
export const RubricFilling = z.record(
  z.string(),
  z.object({ levelId: z.string(), remark: z.string().max(5000).default('') }),
);
export type RubricFilling = z.output<typeof RubricFilling>;

/** A marking guide filled in: the score for each criterion, with a remark. */
export const GuideFilling = z.record(
  z.string(),
  z.object({ score: z.number(), remark: z.string().max(5000).default('') }),
);
export type GuideFilling = z.output<typeof GuideFilling>;

/** The grades an activity takes: points 0..max, or the positions of a scale 1..n. */
export interface GradeRange {
  min: number;
  max: number;
  /** Points keep decimals; scale positions are whole. */
  decimals: boolean;
}

const sumBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

function rubricScores(r: Rubric) {
  return {
    min: sumBy(r.criteria, (c) => Math.min(...c.levels.map((l) => l.score))),
    max: sumBy(r.criteria, (c) => Math.max(...c.levels.map((l) => l.score))),
  };
}

/** What a rubric filling is missing or gets wrong, or null. */
export function rubricFillingError(r: Rubric, f: RubricFilling): string | null {
  for (const c of r.criteria) {
    const chosen = f[c.id];
    if (!chosen) return `Choose a level for "${c.description}"`;
    if (!c.levels.some((l) => l.id === chosen.levelId))
      return `No such level for "${c.description}"`;
  }
  return null;
}

/**
 * The grade of a filled rubric (Moodle's gradingform_rubric): with locked zero points the
 * share of the maximum points, otherwise the points placed between the least and the most.
 */
export function rubricGrade(r: Rubric, f: RubricFilling, range: GradeRange): number | null {
  const { min, max } = rubricScores(r);
  if (max <= min) return null;
  const score = sumBy(
    r.criteria,
    (c) => c.levels.find((l) => l.id === f[c.id]?.levelId)?.score ?? 0,
  );
  const round = (x: number) => (range.decimals ? Math.round(x * 1e5) / 1e5 : Math.round(x));
  if (r.lockZeroPoints) return round(Math.max(range.min, (score / max) * range.max));
  return round(((score - min) / (max - min)) * (range.max - range.min)) + range.min;
}

/** What a guide filling is missing or gets wrong, or null. */
export function guideFillingError(g: Guide, f: GuideFilling): string | null {
  for (const c of g.criteria) {
    const s = f[c.id]?.score;
    if (s === undefined || Number.isNaN(s)) return `Give a score for "${c.shortName}"`;
    if (s < 0 || s > c.maxScore) return `"${c.shortName}" takes 0 to ${c.maxScore}`;
  }
  return null;
}

/** The grade of a filled marking guide (Moodle's gradingform_guide). */
export function guideGrade(g: Guide, f: GuideFilling, range: GradeRange): number | null {
  const max = sumBy(g.criteria, (c) => c.maxScore);
  if (max <= 0) return null;
  const score = sumBy(g.criteria, (c) => f[c.id]?.score ?? 0);
  const offset = (score / max) * (range.max - range.min);
  return (range.decimals ? Math.round(offset * 1e5) / 1e5 : Math.round(offset)) + range.min;
}

/** The criteria as text for the AI grading assistant. */
export function criteriaText(method: GradingMethod, def: Rubric | Guide | null): string {
  if (method === 'rubric' && def && 'lockZeroPoints' in def)
    return def.criteria
      .map(
        (c) =>
          `${c.description}: ${c.levels.map((l) => `${l.score} points — ${l.definition || '—'}`).join('; ')}`,
      )
      .join('\n');
  if (method === 'guide' && def && !('lockZeroPoints' in def))
    return def.criteria
      .map(
        (c) =>
          `${c.shortName} (up to ${c.maxScore}): ${c.descriptionMarkers || c.descriptionStudents}`,
      )
      .join('\n');
  return '';
}

/**
 * A rubric filled from the assistant's judgement of each criterion (0..1, matched by name
 * or else by position): the level nearest that share of the criterion's points.
 */
export function rubricFromShares(
  r: Rubric,
  shares: { name: string; score: number }[],
): RubricFilling {
  return Object.fromEntries(
    r.criteria.map((c, i) => {
      const share = (shares.find((s) => s.name.trim() === c.description.trim()) ?? shares[i])
        ?.score;
      const scores = c.levels.map((l) => l.score);
      const lo = Math.min(...scores);
      const target = lo + Math.min(1, Math.max(0, share ?? 0)) * (Math.max(...scores) - lo);
      const level = [...c.levels].sort(
        (a, b) => Math.abs(a.score - target) - Math.abs(b.score - target),
      )[0]!;
      return [c.id, { levelId: level.id, remark: '' }];
    }),
  );
}

/** A guide filled from the assistant's judgement of each criterion (0..1). */
export function guideFromShares(g: Guide, shares: { name: string; score: number }[]): GuideFilling {
  return Object.fromEntries(
    g.criteria.map((c, i) => {
      const share = (shares.find((s) => s.name.trim() === c.shortName.trim()) ?? shares[i])?.score;
      const score = Math.round(Math.min(1, Math.max(0, share ?? 0)) * c.maxScore * 100) / 100;
      return [c.id, { score, remark: '' }];
    }),
  );
}

/**
 * Can a definition change once forms have been filled with it? Texts and points may; the
 * criteria and levels themselves may not come or go.
 */
export function sameStructure(before: Rubric | Guide, after: Rubric | Guide): boolean {
  const shape = (d: Rubric | Guide) =>
    d.criteria
      .map(
        (c) =>
          `${c.id}:${
            'levels' in c
              ? c.levels
                  .map((l) => l.id)
                  .sort()
                  .join(',')
              : ''
          }`,
      )
      .sort()
      .join('|');
  return shape(before) === shape(after);
}
