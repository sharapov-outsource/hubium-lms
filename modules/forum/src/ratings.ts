// Forum ratings, as Moodle's: each post rated by teachers (and students, when peer
// rating is on) in points 0..max or on a scale, and a student's ratings aggregated into
// one grade. Pure, so the post shows the same figure the gradebook gets.

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

/** Can a rating be given to a post written then (the forum's rating window)? */
export function inRatingWindow(
  created: Date,
  window: { ratingFrom: string | null; ratingTo: string | null },
): boolean {
  if (window.ratingFrom && created < new Date(window.ratingFrom)) return false;
  if (window.ratingTo && created > new Date(window.ratingTo)) return false;
  return true;
}
