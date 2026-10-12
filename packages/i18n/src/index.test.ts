import { describe, expect, it } from 'vitest';
import { createTranslator, fromAcceptLanguage, messages, resolveLocale } from './index.ts';

function keys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('messages', () => {
  it('ru and en have the same keys', () => {
    const ru = new Set(keys(messages.ru));
    const en = new Set(keys(messages.en));
    expect([...ru].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !ru.has(k))).toEqual([]);
  });
  it('no empty strings', () => {
    for (const l of ['ru', 'en'] as const) {
      const empty = keys(messages[l]).filter((k) => {
        const v = k
          .split('.')
          .reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], messages[l]);
        return v === '';
      });
      expect(empty).toEqual([]);
    }
  });
});

describe('locale resolution', () => {
  it('prefers user, then cookie, then course, then site', () => {
    expect(resolveLocale({ user: 'en', cookie: 'ru' })).toBe('en');
    expect(resolveLocale({ cookie: 'en', site: 'ru' })).toBe('en');
    expect(resolveLocale({ course: 'en', site: 'ru' })).toBe('en');
    expect(resolveLocale({ site: 'en', acceptLanguage: 'ru' })).toBe('en');
  });
  it('falls back to Accept-Language and default', () => {
    expect(resolveLocale({ acceptLanguage: 'de-DE,en;q=0.8,ru;q=0.5' })).toBe('en');
    expect(resolveLocale({})).toBe('ru');
    expect(resolveLocale({ user: 'fr' })).toBe('ru');
  });
  it('parses quality values', () => {
    expect(fromAcceptLanguage('en;q=0.1, ru-RU;q=0.9')).toBe('ru');
    expect(fromAcceptLanguage('')).toBeUndefined();
  });
});

describe('translator', () => {
  it('interpolates and pluralises Russian forms', () => {
    const t = createTranslator('ru');
    expect(t('common.studentsCount', { count: 1 })).toBe('1 студент');
    expect(t('common.studentsCount', { count: 3 })).toBe('3 студента');
    expect(t('common.studentsCount', { count: 5 })).toBe('5 студентов');
    expect(t('common.studentsCount', { count: 21 })).toBe('21 студент');
  });
  it('pluralises English', () => {
    const t = createTranslator('en');
    expect(t('common.studentsCount', { count: 1 })).toBe('1 student');
    expect(t('common.studentsCount', { count: 2 })).toBe('2 students');
  });
  it('returns the key for unknown messages', () => {
    expect(createTranslator('en')('nope.nothing')).toBe('nope.nothing');
  });
});
