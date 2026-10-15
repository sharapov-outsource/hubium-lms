import { BASE_LOCALE, isLocale } from '@hubium/i18n';
import { z } from 'zod';

/** A text in several languages, by language code: { ru: 'Студент', de: 'Teilnehmer/in' }. */
export type Localized = Record<string, string>;

const filled = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';

/** The text in `locale`, else in the site language, else in English, else in any language. */
export function pickLocalized(value: unknown, locale: string, site?: string | null): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const v = value as Record<string, unknown>;
  for (const l of [locale, site, BASE_LOCALE]) if (l && filled(v[l])) return v[l];
  return Object.values(v).find(filled) ?? '';
}

/** Texts by language: empty ones and unknown languages are dropped, one at least is needed. */
export function localizedText(max: number) {
  return z.record(z.string(), z.string().trim().max(max)).transform((v, ctx) => {
    const out: Localized = {};
    for (const [code, text] of Object.entries(v)) if (isLocale(code) && text) out[code] = text;
    if (!Object.keys(out).length) {
      ctx.addIssue({ code: 'custom', message: 'errors.field.anyLanguage' });
      return z.NEVER;
    }
    return out;
  });
}

/** Form fields named `<prefix>_<code>` (one per language) as { code: text }. */
export function localizedFromForm(values: Record<string, unknown>, prefix: string): Localized {
  const out: Localized = {};
  for (const [name, value] of Object.entries(values)) {
    if (!name.startsWith(`${prefix}_`) || typeof value !== 'string') continue;
    const code = name.slice(prefix.length + 1);
    if (isLocale(code)) out[code] = value;
  }
  return out;
}
