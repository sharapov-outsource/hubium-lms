import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isoDate } from './fields.ts';
import { type ActivityModule, parseSettings } from './index.ts';

describe('isoDate', () => {
  it('takes a date, an empty input or nothing', () => {
    expect(isoDate.parse('2026-03-01T10:00:00Z')).toBe('2026-03-01T10:00:00.000Z');
    expect(isoDate.parse('')).toBeNull();
    expect(isoDate.parse(null)).toBeNull();
    expect(isoDate.parse(undefined)).toBeNull();
  });

  it('turns a date that is not one into a validation error', () => {
    const r = isoDate.safeParse('not a date');
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('errors.field.invalidDate');
    // past what a Date can hold
    expect(isoDate.safeParse('+300000-01-01T00:00:00Z').success).toBe(false);
  });
});

describe('parseSettings', () => {
  const Settings = z.object({
    title: z.string().default('Untitled'),
    max: z.coerce.number().int().min(1).default(5),
    openAt: isoDate,
  });
  const m = {
    settings: { schema: Settings, defaults: () => Settings.parse({}) },
  } as unknown as ActivityModule<z.output<typeof Settings>>;

  it('keeps the stored fields that still fit when one does not', () => {
    expect(parseSettings(m, { title: 'Kept', max: 0, openAt: '2026-03-01T10:00:00Z' })).toEqual({
      title: 'Kept',
      max: 5,
      openAt: '2026-03-01T10:00:00.000Z',
    });
    expect(parseSettings(m, { title: 'Kept', max: 3, openAt: 'garbage' })).toEqual({
      title: 'Kept',
      max: 3,
      openAt: null,
    });
  });

  it('falls back to the defaults for what is not settings at all', () => {
    expect(parseSettings(m, null)).toEqual({ title: 'Untitled', max: 5, openAt: null });
    expect(parseSettings(m, 'x')).toEqual({ title: 'Untitled', max: 5, openAt: null });
  });
});
