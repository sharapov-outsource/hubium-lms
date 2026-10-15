import { bundledLocales, isLocale, locales } from '@hubium/i18n';
import { createTranslator, installPacks, languageInfo } from '@hubium/i18n/packs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { invalidateLanguagePacks, loadLanguagePacks } from './language-packs.ts';
import {
  installLanguagePack,
  languageOverview,
  languagePackZip,
  readLanguagePack,
  removeLanguagePack,
  saveLanguageSettings,
} from './languages.ts';
import { invalidateSettingsCache } from './settings.ts';

const json = (v: unknown) => strToU8(JSON.stringify(v));
const ukrainian = () =>
  zipSync({
    'hubium-uk/packages/i18n/messages/uk.json': json({
      $language: { name: 'Українська', englishName: 'Ukrainian', tag: 'uk-UA', fts: 'nonesuch' },
      common: { save: 'Зберегти', cancel: 'Скасувати', broken: 'x {' },
    }),
    'hubium-uk/modules/quiz/messages/uk.json': json({ quiz: { name: 'Тест (uk)' } }),
    'hubium-uk/README.md': strToU8('# uk'),
  });

describe('language packs installed from the interface', () => {
  const t = useTestDb();
  afterAll(() => {
    installPacks([]);
    invalidateLanguagePacks();
    invalidateSettingsCache();
  });

  it('reads packs laid out as the repository is, and says what is wrong', () => {
    const p = readLanguagePack('uk.zip', ukrainian());
    expect(p.code).toBe('uk');
    expect(Object.keys(p.modules)).toEqual(['quiz']);
    expect(readLanguagePack('pt-BR.json', json({ common: { save: 'Salvar' } })).code).toBe('pt-BR');
    const refused = (name: string, data: Uint8Array) => {
      try {
        readLanguagePack(name, data);
        return '';
      } catch (e) {
        return (e as { fieldErrors: { file: string[] } }).fieldErrors.file[0]!;
      }
    };
    expect(refused('en.json', json({ common: {} }))).toMatch(/base language/);
    expect(
      refused('two.zip', zipSync({ 'messages/uk.json': json({}), 'messages/be.json': json({}) })),
    ).toMatch(/several languages \(be, uk\)/);
    expect(
      refused('mods.zip', zipSync({ 'modules/quiz/messages/uk.json': json({ quiz: {} }) })),
    ).toMatch(/messages\/uk.json/);
    expect(refused('bad.zip', strToU8('not a zip'))).toMatch(/\.zip or \.json/);
    expect(refused('uk.json', strToU8('{oops'))).toMatch(/not valid JSON/);
  });

  it('a new language is installed, offered and translated; then removed', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const r = await installLanguagePack.run(admin, { fileName: 'uk.zip', data: ukrainian() });
    expect(r).toMatchObject({ code: 'uk', name: 'Українська', replaced: false });
    expect(isLocale('uk')).toBe(true);
    // a search configuration this database does not have: "simple"
    expect(languageInfo('uk').fts).toBe('simple');
    expect(createTranslator('uk')('common.save')).toBe('Зберегти');
    expect(createTranslator('uk')('mod.quiz.name')).toBe('Тест (uk)');
    const row = (await languageOverview(admin)).rows.find((x) => x.code === 'uk')!;
    expect(row).toMatchObject({ source: 'installed', enabled: true });
    expect(row.report.invalid.map((i) => i.key)).toEqual([]);
    expect(row.report.unknown).toContain('common.broken');

    // another process reads the same packs from the database
    installPacks([]);
    expect(isLocale('uk')).toBe(false);
    await loadLanguagePacks(t.db);
    expect(isLocale('uk')).toBe(true);

    // the site language is not removed from under the site
    await saveLanguageSettings.run(admin, {
      defaultLocale: 'uk',
      enabled: [...locales],
      detectBrowser: false,
    });
    await expect(removeLanguagePack.run(admin, { code: 'uk' })).rejects.toMatchObject({
      fieldErrors: { code: ['Choose another site language first'] },
    });
    await saveLanguageSettings.run(admin, {
      defaultLocale: 'ru',
      enabled: [...locales],
      detectBrowser: false,
    });
    await removeLanguagePack.run(admin, { code: 'uk' });
    expect(isLocale('uk')).toBe(false);
    expect(await t.db.languagePack.count()).toBe(0);
  });

  it('a newer pack of a bundled language takes its place until removed', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    expect(bundledLocales).toContain('de');
    const before = createTranslator('de')('common.save');
    const r = await installLanguagePack.run(admin, {
      fileName: 'de.json',
      data: json({ common: { save: 'Sichern' } }),
    });
    expect(r.replaced).toBe(true);
    expect(createTranslator('de')('common.save')).toBe('Sichern');
    expect((await languageOverview(admin)).rows.find((x) => x.code === 'de')!.source).toBe(
      'updated',
    );
    await removeLanguagePack.run(admin, { code: 'de' });
    expect(createTranslator('de')('common.save')).toBe(before);
    await expect(
      installLanguagePack.run(admin, { fileName: 'de.json', data: json({ nothing: 'here' }) }),
    ).rejects.toMatchObject({ fieldErrors: { file: [expect.stringMatching(/No string/)] } });
    // students do not install languages
    await expect(
      installLanguagePack.run(
        await ctxFor(
          t.db,
          (await t.db.user.findFirstOrThrow({ where: { username: 'student1' } })).id,
        ),
        {
          fileName: 'de.json',
          data: json({ common: { save: 'x' } }),
        },
      ),
    ).rejects.toThrow();
  });

  it('downloads a pack as the repository lays it out (the base one is the template)', () => {
    const files = unzipSync(languagePackZip('en'));
    expect(Object.keys(files)).toContain('messages/en.json');
    expect(Object.keys(files)).toContain('modules/quiz/messages/en.json');
    const quiz = JSON.parse(strFromU8(files['modules/quiz/messages/en.json']!));
    expect(Object.keys(quiz)).toEqual(['quiz']);
  });
});
