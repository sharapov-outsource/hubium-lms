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
