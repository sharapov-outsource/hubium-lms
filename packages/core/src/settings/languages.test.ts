import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { syncCapabilities } from '../access/roles.ts';
import { ValidationError } from '../errors.ts';
import { builtInLetters } from '../grades/scales.ts';
import { localizedText, pickLocalized } from '../lib/localized.ts';
import { renderActionEmail } from '../mail/mail.ts';
import { type ProfileField, validateProfileValues } from '../users/profile-fields.ts';
import { createUser } from '../users/users.ts';
import { languageOverview, saveLanguageSettings } from './languages.ts';
import { enabledLocales, getAllSettings, setSettings, siteLocale, userLocale } from './settings.ts';

describe('language settings', () => {
  const t = useTestDb();

  it('disables languages, keeps the site language and falls back to it', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await saveLanguageSettings.run(admin, {
      defaultLocale: 'de',
      enabled: ['de', 'ru'],
      detectBrowser: false,
    });
    try {
      const s = await getAllSettings(t.db);
      expect(siteLocale(s)).toBe('de');
      expect(enabledLocales(s).sort()).toEqual(['de', 'ru']);
      expect(userLocale(s, 'it')).toBe('de');
      expect(userLocale(s, 'ru')).toBe('ru');
      expect(userLocale(s, null)).toBe('de');
      // the built-in letters follow the site language's pack
      expect((await builtInLetters(t.db)).map((l) => l.letter)).toEqual(['A', 'B', 'C', 'D', 'F']);
      const overview = await languageOverview(admin);
      expect(overview.rows.find((r) => r.code === 'it')).toMatchObject({
        enabled: false,
        percent: 100,
      });
      expect(overview.rows.find((r) => r.code === 'de')?.isSite).toBe(true);
      await expect(
        saveLanguageSettings.run(admin, {
          defaultLocale: 'fr',
          enabled: ['ru'],
          detectBrowser: true,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      const { id } = await createUser.run(admin, {
        username: 'polyglot',
        firstName: 'Poly',
        lastName: 'Glot',
        password: 'Password123',
      });
      await expect(languageOverview(await ctxFor(t.db, id))).rejects.toThrow();
    } finally {
      await setSettings(t.db, {
        'site.defaultLocale': 'ru',
        'i18n.disabledLocales': [],
        'i18n.detectBrowser': true,
      });
    }
    expect((await builtInLetters(t.db)).map((l) => l.letter)).toEqual(['5', '4', '3', '2']);
  });

  it('names built-in roles in every language without overwriting the names set by hand', async () => {
    const student = await t.db.role.findUniqueOrThrow({ where: { shortName: 'student' } });
    expect(student.name).toMatchObject({ de: 'Teilnehmer/in', fr: 'Étudiant', it: 'Studente' });
    await t.db.role.update({
      where: { id: student.id },
      data: { name: { ru: 'Слушатель' } },
    });
    await syncCapabilities(t.db);
    const after = await t.db.role.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.name).toMatchObject({ ru: 'Слушатель', en: 'Student', de: 'Teilnehmer/in' });
  });

  it('marks emails with their language', () => {
    const { html } = renderActionEmail({
      locale: 'de',
      siteName: 'LMS',
      heading: 'Hallo',
      intro: 'Text',
      footer: 'Fuß',
    });
    expect(html).toContain('<html lang="de-DE" dir="ltr">');
  });
});

describe('texts in several languages', () => {
  it('picks the language, then the site language, English, any language', () => {
    const name = { ru: 'Поле', de: 'Feld' };
    expect(pickLocalized(name, 'de')).toBe('Feld');
    expect(pickLocalized(name, 'fr', 'ru')).toBe('Поле');
    expect(pickLocalized({ en: 'Field', ru: 'Поле' }, 'it')).toBe('Field');
    expect(pickLocalized({ it: 'Campo' }, 'ru')).toBe('Campo');
    expect(pickLocalized(null, 'ru')).toBe('');
  });

  it('keeps filled texts of installed languages and needs one', () => {
    const schema = localizedText(20);
    expect(schema.parse({ ru: 'Поле', fr: '', xx: 'nope' })).toEqual({ ru: 'Поле' });
    expect(schema.safeParse({ ru: '' }).success).toBe(false);
  });

  it('reads yes and no in every installed language', () => {
    const agree: ProfileField = {
      id: 'x',
      shortName: 'agree',
      name: { en: 'Agree' },
      type: 'checkbox',
      choices: [],
      required: false,
      locked: false,
      visibleToOthers: false,
    };
    for (const [raw, value] of [
      ['ja', true],
      ['Oui', true],
      ['sì', true],
      ['нет', false],
      ['nein', false],
    ] as const)
      expect(validateProfileValues([agree], { agree: raw })).toEqual({ agree: value });
  });
});
