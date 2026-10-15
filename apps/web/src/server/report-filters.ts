import type { FilterValues } from '@hubium/core';

type Params = Record<string, string | string[] | undefined>;

/**
 * The viewer's filters from the address: `f.<field>.op` and `f.<field>.v` (an enum's
 * values joined by commas), with the same values flattened for links that keep them.
 */
export function readFilters(sp: Params): { filters: FilterValues; params: Record<string, string> } {
  const filters: FilterValues = {};
  const params: Record<string, string> = {};
  for (const [k, raw] of Object.entries(sp)) {
    const m = /^f\.(.+)\.(op|v)$/.exec(k);
    if (!m || raw === undefined) continue;
    const v = Array.isArray(raw) ? raw.join(',') : raw;
    if (!v) continue;
    params[k] = v;
    const key = m[1]!;
    const f = (filters[key] ??= { op: '' });
    if (m[2] === 'op') f.op = v;
    else f.value = v.includes(',') ? v.split(',').filter(Boolean) : v;
  }
  for (const [k, f] of Object.entries(filters)) if (!f.op) delete filters[k];
  return { filters, params };
}
