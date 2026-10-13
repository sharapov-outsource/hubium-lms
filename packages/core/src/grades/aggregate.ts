import { languageInfo } from '@hubium/i18n/packs';

// Pure gradebook arithmetic. Grades are normalised to 0..1 against their item's range
// before aggregation; the result is a fraction of the category's maximum.

export type Aggregation = 'NATURAL' | 'MEAN' | 'WEIGHTED_MEAN' | 'HIGHEST' | 'LOWEST' | 'MEDIAN';

export interface AggregateInput {
  /** Raw grade in item units, or null when not graded. */
  value: number | null;
  min: number;
  max: number;
  weight: number;
  excluded?: boolean;
}

export interface AggregateOptions {
  method: Aggregation;
  /** Ignore ungraded items (true, Moodle default) or count them as zero. */
  onlyGraded: boolean;
  dropLowest?: number;
  keepHighest?: number;
}

export function normalise(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Returns the aggregated fraction (0..1), or null when nothing counts. */
export function aggregate(items: AggregateInput[], opts: AggregateOptions): number | null {
  let pool = items
    .filter((i) => !i.excluded && i.max > i.min)
    .map((i) => ({ ...i, value: i.value ?? (opts.onlyGraded ? null : i.min) }))
    .filter((i): i is AggregateInput & { value: number } => i.value !== null)
    .map((i) => ({ ...i, n: normalise(i.value, i.min, i.max) }));
  if (pool.length === 0) return null;

  if (opts.keepHighest && opts.keepHighest > 0) {
    pool = [...pool].sort((a, b) => b.n - a.n).slice(0, opts.keepHighest);
  } else if (opts.dropLowest && opts.dropLowest > 0 && pool.length > opts.dropLowest) {
    pool = [...pool].sort((a, b) => a.n - b.n).slice(opts.dropLowest);
  }

  switch (opts.method) {
    case 'NATURAL': {
      const got = pool.reduce((s, i) => s + (i.value - i.min), 0);
      const range = pool.reduce((s, i) => s + (i.max - i.min), 0);
      return range > 0 ? got / range : null;
    }
    case 'MEAN':
      return pool.reduce((s, i) => s + i.n, 0) / pool.length;
    case 'WEIGHTED_MEAN': {
      const w = pool.reduce((s, i) => s + i.weight, 0);
      if (w <= 0) return null;
      return pool.reduce((s, i) => s + i.n * i.weight, 0) / w;
    }
    case 'HIGHEST':
      return Math.max(...pool.map((i) => i.n));
    case 'LOWEST':
      return Math.min(...pool.map((i) => i.n));
    case 'MEDIAN': {
      const s = pool.map((i) => i.n).sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    }
  }
}

export interface LetterBoundary {
  lowerBound: number;
  letter: string;
}

/** Built-in letter grades of a language (its pack's "$language.letters", else the base's). */
export function defaultLetters(locale: string): LetterBoundary[] {
  return languageInfo(locale).letters.map((l) => ({ ...l }));
}

export function letterFor(percent: number, letters: LetterBoundary[]): string {
  const sorted = [...letters].sort((a, b) => b.lowerBound - a.lowerBound);
  return sorted.find((l) => percent >= l.lowerBound)?.letter ?? sorted.at(-1)?.letter ?? '';
}

export function formatGrade(
  value: number | null | undefined,
  item: {
    min: number;
    max: number;
    decimals: number;
    display: 'REAL' | 'PERCENT' | 'LETTER';
    scale?: string[] | null;
  },
  letters: LetterBoundary[],
  locale?: string,
): string {
  if (value === null || value === undefined) return '—';
  if (item.scale?.length) return item.scale[Math.round(value) - 1] ?? '—';
  const nf = new Intl.NumberFormat(locale, {
    maximumFractionDigits: item.decimals,
    minimumFractionDigits: 0,
  });
  const pct = normalise(value, item.min, item.max) * 100;
  if (item.display === 'PERCENT') return `${nf.format(pct)}%`;
  if (item.display === 'LETTER') return letterFor(pct, letters);
  return nf.format(value);
}
