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
export const localeCode = z.string().trim().refine(isLocale, 'Unknown language');

/** An optional language where an empty form value means "not set" (undefined). */
export const optionalLocale = localeCode.optional().or(z.literal('').transform(() => undefined));
