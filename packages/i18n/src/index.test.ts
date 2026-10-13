import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_LOCALE, fromAcceptLanguage, isLocale, locales, resolveLocale } from './index.ts';
import { createTranslator, languageInfo, messagesFor, packReport } from './packs.ts';

describe('language packs', () => {
  it('the index lists every message file', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    expect(() =>
      execFileSync(process.execPath, [path.join(root, 'scripts/i18n-index.mjs'), '--check'], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('every installed pack is complete and valid', () => {
    expect(locales).toContain(BASE_LOCALE);
    for (const code of locales) {
      const r = packReport(code);
      expect({ code, missing: r.missing, invalid: r.invalid, unknown: r.unknown }).toEqual({
        code,
        missing: [],
        invalid: [],
        unknown: [],
      });
    }
  });

  it('every pack names its language', () => {
    for (const code of locales) {
      const info = languageInfo(code);
      expect(info.name).not.toBe(code);
      expect(info.letters.length).toBeGreaterThan(1);
    }
    expect(languageInfo('ru').letters.map((l) => l.letter)).toEqual(['5', '4', '3', '2']);
  });

  it('keys never contain dots (next-intl uses them for nesting)', () => {
    const bad: string[] = [];
    const walk = (o: unknown, at: string) => {
      if (typeof o !== 'object' || o === null) return;
      for (const [k, v] of Object.entries(o)) {
        if (k.includes('.')) bad.push(`${at}${k}`);
        walk(v, `${at}${k}/`);
      }
    };
    walk(messagesFor(BASE_LOCALE), '');
    expect(bad).toEqual([]);
  });

  it('module strings sit under `mod`', () => {
    const m = messagesFor('en') as unknown as { mod: { assign: { name: string } } };
    expect(m.mod.assign.name).toBe('Assignment');
  });
});

describe('locale resolution', () => {
  it('a course language wins, then the user, the cookie, the browser and the site', () => {
    expect(resolveLocale({ course: 'en', user: 'ru' })).toBe('en');
    expect(resolveLocale({ user: 'en', cookie: 'ru' })).toBe('en');
    expect(resolveLocale({ cookie: 'en', site: 'ru' })).toBe('en');
    expect(resolveLocale({ acceptLanguage: 'en-GB', site: 'ru' })).toBe('en');
    expect(resolveLocale({ site: 'en', acceptLanguage: 'xx' })).toBe('en');
  });

  it('skips languages that are not installed or not enabled', () => {
    expect(resolveLocale({ user: 'xx', site: 'ru' })).toBe('ru');
    expect(resolveLocale({ user: 'en', site: 'ru', enabled: ['ru'] })).toBe('ru');
    expect(resolveLocale({ course: 'en', site: 'ru', enabled: ['ru'] })).toBe('ru');
    expect(resolveLocale({ acceptLanguage: 'en', site: 'ru', enabled: ['ru'] })).toBe('ru');
    expect(resolveLocale({})).toBe(BASE_LOCALE);
  });

  it('can ignore the browser', () => {
    expect(resolveLocale({ acceptLanguage: 'en', site: 'ru', detectBrowser: false })).toBe('ru');
  });

  it('parses quality values and regional tags', () => {
    expect(fromAcceptLanguage('en;q=0.1, ru-RU;q=0.9')).toBe('ru');
    expect(fromAcceptLanguage('de-DE,en;q=0.8,ru;q=0.5', ['ru', 'en'])).toBe('en');
    expect(fromAcceptLanguage('en;q=0')).toBeUndefined();
    expect(fromAcceptLanguage('')).toBeUndefined();
  });

  it('knows installed codes only', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('xx')).toBe(false);
    expect(isLocale(null)).toBe(false);
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

  it('translates module strings and returns unknown keys as they are', () => {
    expect(createTranslator('ru')('mod.assign.name')).not.toBe('mod.assign.name');
    expect(createTranslator('en')('nope.nothing')).toBe('nope.nothing');
  });

  it('an unknown language falls back to the site language, then the base', () => {
    expect(createTranslator('xx', 'ru')('common.studentsCount', { count: 2 })).toBe('2 студента');
    expect(createTranslator('xx')('common.studentsCount', { count: 2 })).toBe('2 students');
  });
});
