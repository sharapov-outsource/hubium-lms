import { describe, expect, it } from 'vitest';
import { normalizeTime, parseDateString, toDateString } from './components/date-picker.tsx';

describe('date picker values', () => {
  it('round-trips calendar days without time-zone drift', () => {
    const d = parseDateString('2026-10-06');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(9);
    expect(d?.getDate()).toBe(6);
    expect(toDateString(d!)).toBe('2026-10-06');
    expect(parseDateString('2026-10-06T14:30')?.getDate()).toBe(6);
  });

  it('rejects malformed dates', () => {
    expect(parseDateString('')).toBeUndefined();
    expect(parseDateString(null)).toBeUndefined();
    expect(parseDateString('06.10.2026')).toBeUndefined();
  });

  it('normalises typed times', () => {
    expect(normalizeTime('9')).toBe('09:00');
    expect(normalizeTime('930')).toBe('09:30');
    expect(normalizeTime('2130')).toBe('21:30');
    expect(normalizeTime('9:5')).toBe('09:05');
    expect(normalizeTime(' 21:30 ')).toBe('21:30');
    expect(normalizeTime('00:00')).toBe('00:00');
  });

  it('rejects impossible times', () => {
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime('24:00')).toBeNull();
    expect(normalizeTime('12:60')).toBeNull();
    expect(normalizeTime('12345')).toBeNull();
    expect(normalizeTime('ab')).toBeNull();
  });
});
