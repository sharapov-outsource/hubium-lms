import { describe, expect, it } from 'vitest';
import { fromZonedValue, toZonedValue } from './zoned.ts';

describe('wall-clock values in a time zone', () => {
  it('reads an instant in the zone, whatever zone the process is in', () => {
    expect(toZonedValue('2026-10-18T20:59:00.000Z', 'Europe/Moscow')).toBe('2026-10-18T23:59');
    expect(toZonedValue('2026-10-18T20:59:00.000Z', 'Asia/Almaty')).toBe('2026-10-19T01:59');
    expect(toZonedValue('2026-10-18T20:59:00.000Z', 'UTC')).toBe('2026-10-18T20:59');
    expect(toZonedValue('', 'UTC')).toBe('');
    expect(toZonedValue('nonsense', 'UTC')).toBe('');
  });

  it('turns a wall-clock value back into the instant', () => {
    expect(fromZonedValue('2026-10-18T23:59', 'Europe/Moscow')).toBe('2026-10-18T20:59:00.000Z');
    expect(fromZonedValue('2026-01-05T09:00', 'America/New_York')).toBe('2026-01-05T14:00:00.000Z');
    expect(fromZonedValue('2026-07-05T09:00', 'America/New_York')).toBe('2026-07-05T13:00:00.000Z');
    expect(fromZonedValue('', 'UTC')).toBe('');
    for (const tz of ['Europe/Berlin', 'Asia/Kolkata', 'Pacific/Auckland']) {
      const iso = '2026-03-29T10:15:00.000Z';
      expect(fromZonedValue(toZonedValue(iso, tz), tz)).toBe(iso);
    }
  });

  it('handles clock changes', () => {
    // Berlin skips 02:00–03:00 on 2026-03-29: a skipped time lands after the change
    expect(fromZonedValue('2026-03-29T02:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z');
    // and repeats 02:00–03:00 on 2026-10-25: the first of the two
    expect(fromZonedValue('2026-10-25T02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z');
  });
});
