// Text and number matching shared by the question types.

export function normaliseText(s: string, caseSensitive: boolean): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return caseSensitive ? t : t.toLocaleLowerCase('ru');
}

/** Moodle-style wildcard match: "*" matches any sequence. */
export function wildcardMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'u',
  );
  return re.test(value);
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

/** Rich text with its tags removed, for "is there any answer" checks. */
export const visibleText = (html: string): string => html.replace(/<[^>]*>/g, '').trim();
