import { z } from 'zod';

// Zod helpers for module settings submitted from HTML forms (strings, "on", empty inputs).

/** ISO date string or null; empty input means "not set". Checked before it is converted:
 *  converting a string that is no date throws, which would be a server error. */
export const isoDate = z
  .union([z.string(), z.null()])
  .optional()
  .refine((v) => !v || !Number.isNaN(Date.parse(v)), 'errors.field.invalidDate')
  .transform((v) => (v ? new Date(v).toISOString() : null));

/** Checkbox value: true, "on", "true" → true. */
export const bool = (d: boolean) =>
  z
    .union([z.boolean(), z.literal('on'), z.literal('true'), z.literal('false')])
    .default(d)
    .transform((v) => v === true || v === 'on' || v === 'true');

/** Optional number where an empty input means "not set" (not 0). */
export const optionalNumber = (min: number, max: number) =>
  z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.coerce.number().min(min).max(max).optional(),
  );
