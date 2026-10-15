/** A report's order: by the column at this position. */
export interface ReportSort {
  column: number;
  desc: boolean;
}

/** The columns with the one at `i` moved by `d`; the sort follows the column it sorts by. */
export function moveColumn<T>(
  columns: T[],
  sort: ReportSort | null,
  i: number,
  d: -1 | 1,
): { columns: T[]; sort: ReportSort | null } {
  const j = i + d;
  if (j < 0 || j >= columns.length) return { columns, sort };
  const next = [...columns];
  [next[i], next[j]] = [next[j]!, next[i]!];
  const at = (k: number) => (k === i ? j : k === j ? i : k);
  return { columns: next, sort: sort && { ...sort, column: at(sort.column) } };
}
