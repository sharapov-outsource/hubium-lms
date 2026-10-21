import { describe, expect, it } from 'vitest';
import { newSeed, seededRandom } from './random.ts';
import { opNow, opRandom, withWriteScope } from './write-scope.ts';

describe('random numbers of an operation', () => {
  it('are the same from the same seed', () => {
    const seed = newSeed();
    const a = seededRandom(seed);
    const b = seededRandom(seed);
    const draws = (r: typeof a) => [r.next(), r.int(10, 20), r.uuid(), r.next()];
    expect(draws(a)).toEqual(draws(b));
    expect(draws(seededRandom(newSeed()))).not.toEqual(draws(seededRandom(seed)));
  });

  it('stay in range and make well-formed UUIDs', () => {
    const r = seededRandom('0123456789abcdef0123456789abcdef');
    for (let i = 0; i < 1000; i++) {
      const x = r.next();
      expect(x >= 0 && x < 1).toBe(true);
      const n = r.int(3, 7);
      expect(n >= 3 && n < 7 && Number.isInteger(n)).toBe(true);
    }
    expect(r.uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(() => seededRandom('nope')).toThrow();
  });

  it('and its time come from its scope, and from the clock outside', async () => {
    const at = new Date('2026-10-01T10:00:00Z');
    const seed = newSeed();
    const inside = await withWriteScope(
      'operation',
      'test',
      // a scope inside keeps the operation's time and numbers
      () => withWriteScope('derived', 'inner', () => [opNow(), opRandom().next()] as const),
      { now: at, seed },
    );
    expect(inside).toEqual([at, seededRandom(seed).next()]);
    expect(opNow().getTime()).toBeGreaterThan(at.getTime());
  });
});
