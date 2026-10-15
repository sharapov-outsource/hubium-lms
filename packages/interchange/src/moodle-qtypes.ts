import { type Dataset, type OrderingGrading, orderingNumberings } from '@hubium/questions';

// Settings of Moodle's ordering and gap questions as Hubium stores them. Moodle XML writes
// them as words (ABSOLUTE_POSITION), backups as numbers (0); both are read here.

const GRADING_NAMES: [string, OrderingGrading][] = [
  ['ALL_OR_NOTHING', 'allOrNothing'],
  ['ABSOLUTE_POSITION', 'absolutePosition'],
  ['RELATIVE_NEXT_EXCLUDE_LAST', 'relativeNextExcludeLast'],
  ['RELATIVE_NEXT_INCLUDE_LAST', 'relativeNextIncludeLast'],
  ['RELATIVE_ONE_PREVIOUS_AND_NEXT', 'relativeOnePreviousAndNext'],
  ['RELATIVE_ALL_PREVIOUS_AND_NEXT', 'relativeAllPreviousAndNext'],
  ['LONGEST_ORDERED_SUBSET', 'longestOrderedSubset'],
  ['LONGEST_CONTIGUOUS_SUBSET', 'longestContiguousSubset'],
  ['RELATIVE_TO_CORRECT', 'relativeToCorrect'],
];
const GRADING_NUMBERS: Record<string, OrderingGrading> = {
  '-1': 'allOrNothing',
  '0': 'absolutePosition',
  '1': 'relativeNextExcludeLast',
  '2': 'relativeNextIncludeLast',
  '3': 'relativeOnePreviousAndNext',
  '4': 'relativeAllPreviousAndNext',
  '5': 'longestOrderedSubset',
  '6': 'longestContiguousSubset',
  '7': 'relativeToCorrect',
};

export function orderingGrading(v: string): OrderingGrading {
  const s = v.trim().toUpperCase();
  if (s in GRADING_NUMBERS) return GRADING_NUMBERS[s]!;
  if (s === 'ABS' || s === 'ABSOLUTE') return 'absolutePosition';
  return GRADING_NAMES.find(([name]) => name === s)?.[1] ?? 'relativeNextExcludeLast';
}

export const orderingGradingName = (g: OrderingGrading) =>
  GRADING_NAMES.find(([, x]) => x === g)![0];

/** Moodle's selecttype: 0/ALL, 1/RANDOM (the default), 2/CONTIGUOUS. */
export function orderingSelect(v: string): 'all' | 'random' | 'contiguous' {
  const s = v.trim().toUpperCase();
  if (s === '0' || s === 'ALL' || s === 'EXACT') return 'all';
  if (s === '2' || s === 'CONTIGUOUS' || s === 'CONTIG') return 'contiguous';
  return 'random';
}

export const orderingLayout = (v: string): 'vertical' | 'horizontal' =>
  ['HORIZONTAL', 'HORI', 'H', '1'].includes(v.trim().toUpperCase()) ? 'horizontal' : 'vertical';

export const orderingNumbering = (v: string) =>
  (orderingNumberings as readonly string[]).includes(v.trim())
    ? (v.trim() as (typeof orderingNumberings)[number])
    : 'none';

export const orderingShowGrading = (v: string) =>
  !['HIDE', 'FALSE', 'NO', '0'].includes(v.trim().toUpperCase());

/** The group and "unlimited" of a drag-and-drop choice, from Moodle's serialised options. */
export function ddwtosOptions(serialised: string): { group: number; infinite: boolean } {
  const g = /"draggroup";(?:s:\d+:"(\d+)"|i:(\d+))/.exec(serialised);
  const inf = /"infinite";(?:b|i):(\d)/.exec(serialised);
  return { group: Number(g?.[1] ?? g?.[2] ?? 1) || 1, infinite: inf?.[1] === '1' };
}

// ── calculated questions ─────────────────────────────────────────────────────────

/** Moodle's tolerance types: 1 relative, 2 nominal, 3 geometric. */
export const toleranceType = (v: string) =>
  v.trim() === '2' || v.trim().toLowerCase() === 'nominal'
    ? ('nominal' as const)
    : v.trim() === '3' || v.trim().toLowerCase() === 'geometric'
      ? ('geometric' as const)
      : ('relative' as const);
export const toleranceTypeNumber = (t: 'relative' | 'nominal' | 'geometric') =>
  t === 'nominal' ? '2' : t === 'geometric' ? '3' : '1';

/** Moodle's answer formats: 1 decimals, 2 significant figures. */
export const answerFormat = (v: string) =>
  v.trim() === '2' ? ('significant' as const) : ('decimals' as const);

/** A dataset from Moodle's options "uniform:1.0:10.0:1" and its items. */
export function datasetFromOptions(name: string, options: string, items: number[]): Dataset {
  const m = /^(uniform|loguniform):([^:]*):([^:]*):(\d*)$/.exec(options.trim());
  const min = Number(m?.[2] ?? 1);
  const max = Number(m?.[3] ?? 10);
  return {
    name,
    min: Number.isFinite(min) ? min : 1,
    max: Number.isFinite(max) && max >= min ? max : Math.max(min, 10),
    decimals: Math.min(10, Number(m?.[4] || 1)),
    distribution: m?.[1] === 'loguniform' && min > 0 ? 'loguniform' : 'uniform',
    items: items.slice(0, 100),
  };
}
