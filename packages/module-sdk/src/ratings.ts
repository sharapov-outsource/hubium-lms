import type { Prisma } from '@hubium/db';
import { z } from 'zod';
import { isoDate, optionalNumber } from './fields.ts';

// Ratings, as Moodle's, shared by modules that rate learners' work (forum posts, glossary
// entries): each item rated in points 0..max or on a scale, and a learner's ratings
// aggregated into one grade. The arithmetic is pure, so an item shows the same figure the
// gradebook gets.

export const ratingAggregates = ['none', 'average', 'count', 'max', 'min', 'sum'] as const;
export type RatingAggregate = (typeof ratingAggregates)[number];

/**
 * The aggregate of ratings, capped at the most a rating can be (count and sum would pass
 * it); on a scale a whole position, as grades on a scale are. null without ratings.
 */
export function aggregateRatings(
  kind: RatingAggregate,
  values: number[],
  max: number,
  scale: boolean,
): number | null {
  if (kind === 'none' || !values.length) return null;
  const sum = values.reduce((s, v) => s + v, 0);
  const v =
    kind === 'average'
      ? sum / values.length
      : kind === 'count'
        ? values.length
        : kind === 'max'
          ? Math.max(...values)
          : kind === 'min'
            ? Math.min(...values)
            : sum;
  const capped = Math.min(max, v);
  return scale ? Math.max(1, Math.round(capped)) : Math.round(capped * 100_000) / 100_000;
}

/** Can an item written then be rated (the rating window)? */
export function inRatingWindow(
  created: Date,
  window: { ratingFrom: string | null; ratingTo: string | null },
): boolean {
  if (window.ratingFrom && created < new Date(window.ratingFrom)) return false;
  if (window.ratingTo && created > new Date(window.ratingTo)) return false;
  return true;
}

/** A scale id from a form: empty means points. */
export const scaleIdField = z
  .preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable())
  .default(null);

/** Settings fields of ratings, spread into a module's settings schema. */
export const ratingFields = {
  /** How a learner's ratings make their grade; none turns ratings off. */
  ratingAggregate: z.enum(ratingAggregates).default('none'),
  /** Ratings on this scale (1-based positions) instead of points 0..ratingMax. */
  ratingScaleId: scaleIdField,
  ratingMax: z.coerce.number().int().min(1).max(100).default(10),
  /** Only items written in this window can be rated (and count). */
  ratingFrom: isoDate,
  ratingTo: isoDate,
  ratingPass: optionalNumber(0, 10_000),
};

/** Items of a scale the course may use (the site's or its own); null for points. */
export async function scaleItems(
  db: Pick<Prisma.TransactionClient, 'scale'>,
  courseId: string,
  id: string | null,
): Promise<string[] | null> {
  if (!id) return null;
  const s = await db.scale.findFirst({
    where: { id, OR: [{ courseId: null }, { courseId }] },
    select: { items: true },
  });
  return s?.items ?? null;
}
