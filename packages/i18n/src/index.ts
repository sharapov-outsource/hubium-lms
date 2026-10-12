import en from '../messages/en.json' with { type: 'json' };
import ru from '../messages/ru.json' with { type: 'json' };

export const locales = ['ru', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'ru';
export const LOCALE_COOKIE = 'hubium-locale';

export type Messages = typeof ru;
export const messages: Record<Locale, Messages> = { ru, en };

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (locales as readonly string[]).includes(v);
}

/** Picks the best supported locale from an Accept-Language header. */
export function fromAcceptLanguage(header: string | null | undefined): Locale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q.split('=')[1]) : 1 };
    })
    .filter((x) => x.tag && !Number.isNaN(x.q))
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }
  return undefined;
}

/** Locale order: user profile → cookie → course forced lang → site default → Accept-Language. */
export function resolveLocale(opts: {
  user?: string | null;
  cookie?: string | null;
  course?: string | null;
  site?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  for (const c of [opts.user, opts.cookie, opts.course]) if (isLocale(c)) return c;
  if (isLocale(opts.site)) return opts.site;
  return fromAcceptLanguage(opts.acceptLanguage) ?? defaultLocale;
}

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Messages>;

function lookup(obj: unknown, key: string): string | undefined {
  let cur: unknown = obj;
  for (const p of key.split('.')) {
    if (cur && typeof cur === 'object' && p in cur) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * Minimal server-side translator for the worker (emails, notifications).
 * Supports {var} interpolation and ICU-style {n, plural, one{..} few{..} many{..} other{..}}.
 */
export function createTranslator(locale: Locale) {
  const plural = new Intl.PluralRules(locale);
  return function t(
    key: MessageKey | (string & {}),
    values: Record<string, string | number> = {},
  ): string {
    const raw = lookup(messages[locale], key) ?? lookup(messages[defaultLocale], key) ?? key;
    return format(raw, values, plural);
  };
}

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
