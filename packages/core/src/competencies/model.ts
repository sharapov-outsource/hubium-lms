import { z } from 'zod';

// The pure parts of competencies: how a scale is read for them, the taxonomies of tree
// levels, and the rules by which a parent competency follows its children.

/** Moodle's taxonomy terms for the levels of a framework. */
export const TAXONOMIES = [
  'behaviour',
  'competency',
  'concept',
  'domain',
  'indicator',
  'level',
  'outcome',
  'practice',
  'proficiency',
  'skill',
  'value',
] as const;
export type Taxonomy = (typeof TAXONOMIES)[number];

/** The term for a level (0: the top), the last one repeating below. */
export function taxonomyAt(taxonomies: readonly string[], depth: number): Taxonomy {
  const t = taxonomies[Math.min(depth, taxonomies.length - 1)];
  return (TAXONOMIES as readonly string[]).includes(t ?? '') ? (t as Taxonomy) : 'competency';
}

/**
 * How a scale rates competencies: the value given on completion, and the values that
 * count as proficient. Values are 1-based positions in the scale's items, as in Moodle.
 */
export const ScaleConfig = z.object({
  default: z.number().int().min(1),
  proficient: z.array(z.number().int().min(1)).min(1),
});
export type ScaleConfigT = z.infer<typeof ScaleConfig>;

/** The configuration, or why it does not fit a scale of `items` values. */
export function checkScaleConfig(raw: unknown, items: number): ScaleConfigT {
  const c = ScaleConfig.parse(raw);
  if (items < 1) throw new Error('The scale has no values');
  if (c.default > items || c.proficient.some((v) => v > items))
    throw new Error('A value is not on the scale');
  if (!c.proficient.includes(c.default)) throw new Error('The default value must be proficient');
  return { default: c.default, proficient: [...new Set(c.proficient)].sort((a, b) => a - b) };
}

export const isProficient = (c: ScaleConfigT, grade: number | null | undefined) =>
  grade !== null && grade !== undefined && c.proficient.includes(grade);

// ── rules ────────────────────────────────────────────────────────────────────

export const OUTCOMES = ['NONE', 'EVIDENCE', 'RECOMMEND', 'COMPLETE'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const PointsConfig = z.object({
  /** Points needed. */
  points: z.number().int().min(1),
  children: z
    .array(
      z.object({
        id: z.string(),
        points: z.number().int().min(0),
        required: z.boolean().default(false),
      }),
    )
    .min(1),
});
export type PointsConfigT = z.infer<typeof PointsConfig>;

/** A points rule that can be met with the given children. */
export function checkPointsConfig(raw: unknown, childIds: readonly string[]): PointsConfigT {
  const c = PointsConfig.parse(raw);
  const ids = new Set(childIds);
  if (c.children.some((x) => !ids.has(x.id)))
    throw new Error('A rule names a competency that is not a child');
  if (new Set(c.children.map((x) => x.id)).size !== c.children.length)
    throw new Error('A rule names a child twice');
  const total = c.children.reduce((n, x) => n + x.points, 0);
  if (total < c.points) throw new Error('The children cannot add up to the points needed');
  return c;
}

/**
 * Whether a parent's rule is met by its children's proficiency. ALL: every child is
 * proficient (and there is one). POINTS: the proficient children carry enough points,
 * and every required child is among them.
 */
export function competencyRuleMet(
  type: 'ALL' | 'POINTS',
  config: PointsConfigT | null,
  children: readonly string[],
  proficient: ReadonlySet<string>,
): boolean {
  if (type === 'ALL') return children.length > 0 && children.every((c) => proficient.has(c));
  if (!config) return false;
  let points = 0;
  for (const c of config.children) {
    const has = proficient.has(c.id);
    if (c.required && !has) return false;
    if (has) points += c.points;
  }
  return points >= config.points;
}
