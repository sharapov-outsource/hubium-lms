import { describe, expect, it } from 'vitest';
import { optionalText } from './zod.ts';

describe('optionalText', () => {
  it('treats empty and blank strings as unset', () => {
    const s = optionalText(10);
    expect(s.parse('')).toBeUndefined();
    expect(s.parse('   ')).toBeUndefined();
    expect(s.parse(undefined)).toBeUndefined();
    expect(s.parse(' x ')).toBe('x');
    expect(s.safeParse('x'.repeat(11)).success).toBe(false);
  });
});
