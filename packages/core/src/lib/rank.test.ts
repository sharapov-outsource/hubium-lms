import { describe, expect, it } from 'vitest';
import { initialRanks, rankBetween } from './rank.ts';

describe('rankBetween', () => {
  it('creates a first key', () => {
    expect(rankBetween()).toBe('i');
  });
  it('orders after and before', () => {
    const a = rankBetween();
    const b = rankBetween(a, null);
    const c = rankBetween(null, a);
    expect(c < a && a < b).toBe(true);
  });
  it('fits between adjacent keys', () => {
    const k = rankBetween('a', 'b');
    expect('a' < k && k < 'b').toBe(true);
  });
  it('never ends with 0 and stays ordered under repeated inserts at the front', () => {
    let first = rankBetween();
    for (let i = 0; i < 200; i++) {
      const next = rankBetween(null, first);
      expect(next < first).toBe(true);
      expect(next.endsWith('0')).toBe(false);
      first = next;
    }
  });
  it('stays ordered under repeated inserts in the middle', () => {
    let lo = rankBetween();
    const hi = rankBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      lo = mid;
    }
  });
  it('rejects inverted bounds', () => {
    expect(() => rankBetween('b', 'a')).toThrow();
  });
  it('sorts the same way as PostgreSQL text with digits and lowercase', () => {
    const keys = initialRanks(50);
    expect([...keys].sort()).toEqual(keys);
  });
});
