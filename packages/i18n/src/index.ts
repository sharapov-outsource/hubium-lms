import { LOCALE_CODES } from './generated/locales.ts';

// Languages are data: a language exists when packages/i18n/messages/<code>.json does
// (see docs/i18n.md). This entry point is light — it never loads message files; the
// packs, their checks and translators live in `@hubium/i18n/packs`.

/** A language code of an installed pack, e.g. `de` or `pt-BR`. */
export type Locale = string;

/** Every installed language, by code. */
export const locales: readonly Locale[] = LOCALE_CODES;
/** The last fallback: complete by test, and what a missing or broken string falls back to. */
export const BASE_LOCALE: Locale = 'en';
/** The site language of a fresh installation. */
export const DEFAULT_SITE_LOCALE: Locale = 'ru';
export const LOCALE_COOKIE = 'hubium-locale';

export type Messages = Omit<typeof import('../messages/en.json'), '$language'>;

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (locales as readonly string[]).includes(v);
}

/** Picks the best of `allowed` from an Accept-Language header: `de-AT` matches `de`. */
export function fromAcceptLanguage(
  header: string | null | undefined,
  allowed: readonly Locale[] = locales,
): Locale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: (tag ?? '').trim(), q: q ? Number(q.split('=')[1]) : 1 };
    })
    .filter((x) => x.tag && !Number.isNaN(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q);
  const byLower = new Map(allowed.map((l) => [l.toLowerCase(), l]));
  for (const { tag } of ranked) {
    const t = tag.toLowerCase();
    const hit = byLower.get(t) ?? byLower.get(t.split('-')[0]!);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The language of a request: a course's forced language, the user's choice (profile, then
 * the cookie of guests), the browser's languages when detection is on, the site language,
 * then the base. Codes that are not installed or not enabled are skipped.
 */
export function resolveLocale(opts: {
  course?: string | null;
  user?: string | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
  site?: string | null;
  /** Languages offered to users; all installed ones when omitted. */
  enabled?: readonly Locale[];
  detectBrowser?: boolean;
}): Locale {
  const enabled = (opts.enabled ?? locales).filter(isLocale);
  const ok = (c: string | null | undefined): c is Locale => !!c && enabled.includes(c);
  for (const c of [opts.course, opts.user, opts.cookie]) if (ok(c)) return c;
  if (opts.detectBrowser !== false) {
    const fromBrowser = fromAcceptLanguage(opts.acceptLanguage, enabled);
    if (fromBrowser) return fromBrowser;
  }
  if (isLocale(opts.site)) return opts.site;
  return ok(BASE_LOCALE) ? BASE_LOCALE : (enabled[0] ?? BASE_LOCALE);
}

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Messages>;

/**
 * {var} interpolation and ICU-style plurals:
 * {n, plural, =0{..} one{..} few{..} many{..} other{..}} with # for the number.
 */
export function format(
  raw: string,
  values: Record<string, string | number>,
  plural: Intl.PluralRules,
): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < raw.length && depth > 0) {
      if (raw[j] === '{') depth++;
      else if (raw[j] === '}') depth--;
      j++;
    }
    const body = raw.slice(i + 1, j - 1);
    const [name, kind, ...rest] = body.split(',');
    const v = values[name!.trim()];
    if (kind?.trim() === 'plural' && typeof v === 'number') {
      const opts = rest.join(',');
      const cat = plural.select(v);
      const re = /(=\d+|zero|one|two|few|many|other)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
      const forms: Record<string, string> = {};
      for (const m of opts.matchAll(re)) forms[m[1]!] = m[2]!;
      const chosen = forms[`=${v}`] ?? forms[cat] ?? forms.other ?? '';
      out += chosen.replace(/#/g, String(v));
    } else {
      out += v === undefined ? `{${body}}` : String(v);
    }
    i = j;
  }
  return out;
}
