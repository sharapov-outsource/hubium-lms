// Values from the address bar, which anyone can type: what a page cannot use is left out,
// so a page opens with its defaults instead of failing.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id, or nothing when the value is not one. */
export function uuidParam(v: string | undefined): string | undefined {
  return v && UUID.test(v) ? v : undefined;
}

/** A page number: 1 when the value is not a whole number from 1 up. */
export function pageParam(v: string | undefined): number {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/** Search text, cut to the length a search takes. */
export function textParam(v: string | undefined, max = 100): string | undefined {
  const s = v?.trim().slice(0, max);
  return s || undefined;
}

/** A calendar date (YYYY-MM-DD) that exists, or nothing. */
export function dateParam(v: string | undefined): string | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  return Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) ? undefined : v;
}
