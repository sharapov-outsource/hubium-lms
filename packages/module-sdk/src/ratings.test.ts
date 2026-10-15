import { describe, expect, it } from 'vitest';
import { aggregateRatings, inRatingWindow } from './ratings.ts';

describe('ratings', () => {
  it('aggregates as Moodle does, capped at the most a rating can be', () => {
    const v = [4, 7, 10];
    expect(aggregateRatings('average', v, 10, false)).toBe(7);
    expect(aggregateRatings('count', v, 10, false)).toBe(3);
    expect(aggregateRatings('max', v, 10, false)).toBe(10);
    expect(aggregateRatings('min', v, 10, false)).toBe(4);
    // the sum would be 21: the grade stops at the maximum
    expect(aggregateRatings('sum', v, 10, false)).toBe(10);
    expect(aggregateRatings('average', [1, 2], 10, false)).toBe(1.5);
    expect(aggregateRatings('average', [1, 1, 2], 10, false)).toBe(1.33333);
    expect(aggregateRatings('none', v, 10, false)).toBeNull();
    expect(aggregateRatings('average', [], 10, false)).toBeNull();
  });

  it('gives a whole scale position on a scale', () => {
    // scale of three: 1, 2 → 1.5 rounds to 2
    expect(aggregateRatings('average', [1, 2], 3, true)).toBe(2);
    expect(aggregateRatings('sum', [3, 3], 3, true)).toBe(3);
    expect(aggregateRatings('count', [1], 3, true)).toBe(1);
  });

  it('rates items written within the window', () => {
    const w = { ratingFrom: '2026-10-01T00:00:00Z', ratingTo: '2026-10-31T00:00:00Z' };
    expect(inRatingWindow(new Date('2026-10-10T00:00:00Z'), w)).toBe(true);
    expect(inRatingWindow(new Date('2026-09-30T00:00:00Z'), w)).toBe(false);
    expect(inRatingWindow(new Date('2026-11-01T00:00:00Z'), w)).toBe(false);
    expect(inRatingWindow(new Date(), { ratingFrom: null, ratingTo: null })).toBe(true);
  });
});
