import { isLocale } from '@hubium/i18n';
import { z } from 'zod';

/** Optional trimmed text where an empty form value means "not set" (undefined). */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));
}

/** The code of an installed language (see @hubium/i18n). */
export const localeCode = z.string().trim().refine(isLocale, 'errors.settings.unknownLanguage');

/** An optional language where an empty form value means "not set" (undefined). */
export const optionalLocale = localeCode.optional().or(z.literal('').transform(() => undefined));

/** Whether the runtime knows the IANA time zone ("Europe/Moscow"; not "MSK"). */
export function isTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone: dates are formatted in it, and a name the runtime does not know breaks
 *  every page that shows one. */
export const timeZone = z.string().trim().refine(isTimeZone, 'errors.account.unknownTimeZone');

/** The zone when it is one, else the fallback: for zones stored before they were checked. */
export const zoneOr = (tz: string | null | undefined, fallback: string): string =>
  tz && isTimeZone(tz) ? tz : fallback;
