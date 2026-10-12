// Fractional ranks for ordered lists (sections, activities). Inserting between two items
// writes one row. Base-36 lowercase digits keep PostgreSQL's default collation and JS
// string comparison in agreement. Keys never end with '0'.

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`rank: ${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/** A rank strictly between `before` and `after` (either may be missing). */
export function rankBetween(before?: string | null, after?: string | null): string {
  return midpoint(before ?? '', after ?? null);
}

/** `n` evenly spread ranks, for seeding or rebalancing. */
export function initialRanks(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}

export function compareRank(a: { rank: string }, b: { rank: string }): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
}
