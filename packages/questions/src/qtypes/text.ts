// Text and number matching shared by the question types.

export function normaliseText(s: string, caseSensitive: boolean): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return caseSensitive ? t : t.toLocaleLowerCase('ru');
}

/**
 * Moodle-style wildcard match: "*" matches any sequence. The parts between the stars are
 * found in order from the left, which takes linear time whatever the answer; a regular
 * expression with several ".*" backtracks for ages on a long answer that almost matches.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === value;
  const head = parts[0]!;
  const tail = parts.at(-1)!;
  if (value.length < head.length + tail.length) return false;
  if (!value.startsWith(head) || !value.endsWith(tail)) return false;
  let from = head.length;
  const end = value.length - tail.length;
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const at = value.indexOf(part, from);
    if (at < 0 || at + part.length > end) return false;
    from = at + part.length;
  }
  return true;
}

export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Text of a response field, empty when missing. */
export const textOf = (r: Record<string, unknown>, key = 'text'): string =>
  typeof r[key] === 'string' ? (r[key] as string) : '';

/** Rich text with its tags and blank spaces (`&nbsp;` too) removed, for "is there any answer"
 *  checks. */
export const visibleText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|#160|#xa0);/gi, ' ')
    .trim();
