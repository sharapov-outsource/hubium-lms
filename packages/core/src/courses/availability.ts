import { z } from 'zod';

// Activity/section availability ("restrict access"). A JSON tree of AND/OR conditions,
// evaluated by a pure function that also explains what is missing.

export const ConditionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('date'),
    op: z.enum(['>=', '<']),
    at: z.string().datetime({ offset: true }),
  }),
  z.object({
    type: z.literal('completion'),
    activityId: z.string().uuid(),
    state: z.enum(['complete', 'incomplete', 'pass', 'fail']),
  }),
  z.object({ type: z.literal('group'), groupId: z.string().uuid().optional() }),
  z.object({
    type: z.literal('grade'),
    activityId: z.string().uuid(),
    min: z.number().min(0).max(100).optional(),
    max: z.number().min(0).max(100).optional(),
  }),
  z.object({
    type: z.literal('profile'),
    field: z.enum(['email', 'firstName', 'lastName', 'username']),
    op: z.enum(['equals', 'contains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty']),
    value: z.string().default(''),
  }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export interface AvailabilityTree {
  op: '&' | '|';
  /** Hide the item entirely (instead of showing it greyed out) when not available. */
  hidden?: boolean;
  c: (Condition | AvailabilityTree)[];
}

export const AvailabilityTreeSchema: z.ZodType<AvailabilityTree> = z.lazy(() =>
  z.object({
    op: z.enum(['&', '|']),
    hidden: z.boolean().optional(),
    c: z.array(z.union([ConditionSchema, AvailabilityTreeSchema])).max(50),
  }),
);

export type CompletionFact = 'complete' | 'incomplete' | 'pass' | 'fail';

export interface AvailabilityFacts {
  now: Date;
  completion: ReadonlyMap<string, CompletionFact>;
  groupIds: ReadonlySet<string>;
  /** activityId → grade in percent (0..100). */
  grades: ReadonlyMap<string, number>;
  profile: Partial<Record<'email' | 'firstName' | 'lastName' | 'username', string>>;
}

export interface AvailabilityResult {
  available: boolean;
  /** True when unavailable and the tree asks to hide the item. */
  hidden: boolean;
  /** Conditions not met (for AND trees) or the alternatives (for OR trees). */
  missing: Condition[];
}

function isTree(x: Condition | AvailabilityTree): x is AvailabilityTree {
  return 'op' in x && 'c' in x && Array.isArray((x as AvailabilityTree).c);
}

function completionMatches(
  want: Condition & { type: 'completion' },
  got: CompletionFact | undefined,
): boolean {
  const state = got ?? 'incomplete';
  switch (want.state) {
    case 'complete':
      return state !== 'incomplete';
    case 'incomplete':
      return state === 'incomplete';
    case 'pass':
      return state === 'pass';
    case 'fail':
      return state === 'fail';
  }
}

export function evaluateCondition(c: Condition, f: AvailabilityFacts): boolean {
  switch (c.type) {
    case 'date': {
      const at = new Date(c.at).getTime();
      return c.op === '>=' ? f.now.getTime() >= at : f.now.getTime() < at;
    }
    case 'completion':
      return completionMatches(c, f.completion.get(c.activityId));
    case 'group':
      return c.groupId ? f.groupIds.has(c.groupId) : f.groupIds.size > 0;
    case 'grade': {
      const g = f.grades.get(c.activityId);
      if (g === undefined) return false;
      return (c.min === undefined || g >= c.min) && (c.max === undefined || g < c.max);
    }
    case 'profile': {
      const v = (f.profile[c.field] ?? '').toLowerCase();
      const want = c.value.toLowerCase();
      switch (c.op) {
        case 'equals':
          return v === want;
        case 'contains':
          return v.includes(want);
        case 'startsWith':
          return v.startsWith(want);
        case 'endsWith':
          return v.endsWith(want);
        case 'isEmpty':
          return v === '';
        case 'isNotEmpty':
          return v !== '';
      }
    }
  }
}

export function evaluateAvailability(
  tree: AvailabilityTree | null | undefined,
  f: AvailabilityFacts,
): AvailabilityResult {
  if (!tree || tree.c.length === 0) return { available: true, hidden: false, missing: [] };
  const missing: Condition[] = [];
  const results = tree.c.map((node) => {
    if (isTree(node)) {
      const r = evaluateAvailability(node, f);
      if (!r.available) missing.push(...r.missing);
      return r.available;
    }
    const ok = evaluateCondition(node, f);
    if (!ok) missing.push(node);
    return ok;
  });
  const available = tree.op === '&' ? results.every(Boolean) : results.some(Boolean);
  return { available, hidden: !available && !!tree.hidden, missing: available ? [] : missing };
}

/** Parses stored JSON; invalid trees are treated as "no restriction" but reported. */
export function parseAvailability(raw: unknown): AvailabilityTree | null {
  if (raw === null || raw === undefined) return null;
  const r = AvailabilityTreeSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Activity ids referenced by completion/grade conditions (for dependency checks). */
export function referencedActivities(tree: AvailabilityTree | null): string[] {
  if (!tree) return [];
  const out: string[] = [];
  for (const n of tree.c) {
    if (isTree(n)) out.push(...referencedActivities(n));
    else if (n.type === 'completion' || n.type === 'grade') out.push(n.activityId);
  }
  return out;
}
