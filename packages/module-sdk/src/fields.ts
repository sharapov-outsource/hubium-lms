import { z } from 'zod';

// Zod helpers for module settings submitted from HTML forms (strings, "on", empty inputs).

/** ISO date string or null; empty input means "not set". */
export const isoDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v ? new Date(v).toISOString() : null))
  .refine((v) => v === null || !Number.isNaN(Date.parse(v)), 'Invalid date');

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
