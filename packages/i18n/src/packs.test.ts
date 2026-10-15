import { describe, expect, it, vi } from 'vitest';

// A partial and partly broken pack "xx" next to small en and ru packs: what is missing or
// broken must come from the site language, then from the base, never as an empty string.
vi.mock('./generated/locales.ts', () => ({ LOCALE_CODES: ['en', 'ru', 'xx'] }));
vi.mock('./generated/packs.ts', () => ({
  corePacks: {
    en: {
      $language: { name: 'English' },
      common: {
        save: 'Save',
        hello: 'Hello, {name}',
        files: '{n, plural, one {# file} other {# files}}',
        only: 'Only in English',
      },
    },
    ru: {
      $language: {
        name: 'Русский',
        letters: [
          ['5', 85],
          ['2', 0],
        ],
      },
      common: { save: 'Сохранить', hello: 'Привет, {name}', only: 'Только по-русски' },
    },
    xx: {
      $language: { name: 'Xxish', tag: 'xx-XX', fts: 'simple' },
      common: {
        save: 'Sxve',
        hello: 'Hxllo, {nome}',
        files: '{n, plural, one {# fxle}}',
        extra: 'not in the base',
        only: '',
      },
    },
  },
  modulePacks: {
    en: [{ quiz: { name: 'Quiz', start: 'Start {n}' } }],
    ru: [{ quiz: { name: 'Тест' } }],
    xx: [{ quiz: { start: "Stxrt '{n}'" } }],
  },
}));

const {
  checkPack,
  createTranslator,
  installPacks,
  languageInfo,
  messagesFor,
  packReport,
  packSource,
  problemOf,
} = await import('./packs.ts');
const { isLocale, locales } = await import('./index.ts');

describe('a broken pack', () => {
  it('reports what is missing, dropped and unknown', () => {
    const r = packReport('xx');
    expect(r.total).toBe(6);
    expect(r.translated).toBe(1);
    expect(r.missing.sort()).toEqual(['mod.quiz.name']);
    expect(r.unknown).toEqual(['common.extra']);
    expect(r.invalid.map((i) => i.key).sort()).toEqual([
      'common.files',
      'common.hello',
      'common.only',
      'mod.quiz.start',
    ]);
  });

  it('never shows a dropped or missing string', () => {
    const t = createTranslator('xx', 'ru');
    expect(t('common.save')).toBe('Sxve');
    expect(t('common.hello', { name: 'Ann' })).toBe('Привет, Ann');
    expect(t('common.only')).toBe('Только по-русски');
    // the site language lacks it as well: the base fills in
    expect(t('common.files', { n: 2 })).toBe('2 files');
    expect(t('mod.quiz.start', { n: 3 })).toBe('Start 3');
    expect(t('mod.quiz.name')).toBe('Тест');
    const tree = messagesFor('xx', 'ru') as unknown as { common: Record<string, string> };
    expect(tree.common).toEqual({
      save: 'Sxve',
      hello: 'Привет, {name}',
      files: '{n, plural, one {# file} other {# files}}',
      only: 'Только по-русски',
    });
    expect(tree.common).not.toHaveProperty('extra');
  });

  it('describes languages from their "$language" block', () => {
    expect(languageInfo('xx')).toMatchObject({ name: 'Xxish', tag: 'xx-XX', dir: 'ltr' });
    expect(languageInfo('ru').letters).toEqual([
      { letter: '5', lowerBound: 85 },
      { letter: '2', lowerBound: 0 },
    ]);
    // no letters of its own: the base language's
    expect(languageInfo('xx').letters[0]).toEqual({ letter: 'A', lowerBound: 90 });
    expect(languageInfo('en').englishName).toBe('English');
  });

  it('names each problem', () => {
    expect(problemOf('Hi {name}', 'Salut {nom}')).toMatch(/placeholders/);
    // an ASCII apostrophe before a brace quotes it: the placeholder is gone
    expect(problemOf('{n} files', "l'{n}'")).toMatch(/placeholders/);
    expect(problemOf('{n} files', 'l’{n}')).toBeNull();
    expect(problemOf('Open', 'Open {')).toMatch(/invalid ICU/);
    expect(problemOf('Open', 'profile_field_<short name>')).toMatch(/invalid ICU/);
    expect(problemOf('<docs>Docs</docs>', 'Doku')).toMatch(/tags/);
    expect(problemOf('{n, plural, one {#} other {#}}', '{n, plural, one {#}}')).toMatch(/ICU/);
    expect(problemOf('x', 3)).toBe('not text');
  });

  it('installs packs at run time: a new language, or a newer bundled one', () => {
    const uk = {
      code: 'uk',
      core: { $language: { name: 'Українська' }, common: { save: 'Зберегти' } },
      modules: [{ quiz: { name: 'Тест (uk)' } }],
    };
    expect(checkPack('uk', uk.core, uk.modules)).toMatchObject({ translated: 2, total: 6 });
    // the base is always the bundled one
    installPacks([
      uk,
      { code: 'ru', core: { common: { save: 'Сохранить!' } }, modules: [] },
      {
        code: 'en',
        core: { common: { save: 'Nope' } },
        modules: [],
      },
    ]);
    expect(locales).toEqual(['en', 'ru', 'xx', 'uk']);
    expect(isLocale('uk')).toBe(true);
    expect(languageInfo('uk').name).toBe('Українська');
    expect([packSource('uk'), packSource('ru'), packSource('en')]).toEqual([
      'installed',
      'updated',
      'bundled',
    ]);
    const t = createTranslator('uk', 'ru');
    expect(t('common.save')).toBe('Зберегти');
    expect(t('mod.quiz.name')).toBe('Тест (uk)');
    expect(t('common.only')).toBe('Only in English');
    expect(createTranslator('ru')('common.save')).toBe('Сохранить!');
    expect(createTranslator('en')('common.save')).toBe('Save');
    // removed again: the bundled ones only
    installPacks([]);
    expect(locales).toEqual(['en', 'ru', 'xx']);
    expect(createTranslator('ru')('common.save')).toBe('Сохранить');
  });
});
