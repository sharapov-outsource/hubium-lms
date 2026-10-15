import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, login } from './helpers';

// Language packs: switching, an administrator disabling a language, guests getting their
// browser's language, and a course that forces its language. Settings and data changed
// here are put back at the end of each test.

/** Sets or (undefined) resets a site setting and tells the app to reload its settings. */
async function setting(key: string, value: unknown) {
  if (value === undefined) await sql(`DELETE FROM "SiteSetting" WHERE key = $1`, [key]);
  else
    await sql(
      `INSERT INTO "SiteSetting"(key, value, "updatedAt") VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      [key, JSON.stringify(value)],
    );
  await sql(`SELECT pg_notify('hubium_cache', 'settings')`);
}

test('a user switches to German and back', async ({ page }) => {
  await sql(`UPDATE "User" SET locale = NULL WHERE username = 'student2'`);
  try {
    await login(page, 'student2', DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Язык' }).click();
    await page.getByRole('menuitem', { name: 'Deutsch' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('link', { name: 'Startseite' }).first()).toBeVisible();
    await expectAccessible(page);
  } finally {
    await sql(`UPDATE "User" SET locale = NULL WHERE username = 'student2'`);
  }
});

test('an administrator disables a language', async ({ page }) => {
  await sql(`UPDATE "User" SET locale = 'it' WHERE username = 'student3'`);
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/languages');
    await expect(page.getByRole('heading', { name: 'Языки', level: 1 })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('checkbox', { name: 'Включён: Italiano' }).uncheck();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();

    // the language is gone from the switcher, and its users see the site language
    await page.context().clearCookies();
    await login(page, 'student3', DEMO_PASSWORD);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.getByRole('button', { name: 'Язык' }).click();
    await expect(page.getByRole('menuitem', { name: 'Deutsch' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Italiano' })).toHaveCount(0);
  } finally {
    await setting('i18n.disabledLocales', undefined);
    await sql(`UPDATE "User" SET locale = NULL WHERE username = 'student3'`);
  }
});

test('guests get the language of their browser unless that is switched off', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  try {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Connexion à');
    await setting('i18n.detectBrowser', false);
    await expect
      .poll(async () => {
        await page.reload();
        return page.locator('html').getAttribute('lang');
      })
      .toBe('ru');
  } finally {
    await setting('i18n.detectBrowser', undefined);
    await context.close();
  }
});

test('a course can force its language', async ({ page }) => {
  const [course] = await sql<{ id: string }>(
    `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-LIT'`,
  );
  await sql(`UPDATE "Course" SET lang = 'en' WHERE id = $1`, [course!.id]);
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.goto(`/course/${course!.id}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.goto('/dashboard');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  } finally {
    await sql(`UPDATE "Course" SET lang = NULL WHERE id = $1`, [course!.id]);
  }
});

test('an administrator installs a language pack, people use it, and it is removed', async ({
  page,
}) => {
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/languages');
    // a pack of interface strings: a few translated, the rest falls back
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'lang-')), 'uk.json');
    writeFileSync(
      file,
      JSON.stringify({
        $language: { name: 'Українська', englishName: 'Ukrainian', tag: 'uk-UA' },
        nav: { dashboard: 'Головна' },
        common: { save: 'Зберегти' },
      }),
    );
    await page.getByLabel('Пакет (.zip или .json)').setInputFiles(file);
    await page.getByRole('button', { name: 'Установить', exact: true }).click();
    await expect(page.getByText(/Язык «Українська» установлен/).first()).toBeVisible();
    const row = page.getByRole('row', { name: /Українська/ });
    await expect(row.getByText('Установлен', { exact: true })).toBeVisible();
    await expectAccessible(page);

    // the English pack is the template to translate
    const template = await page.request.get('/admin/languages/en/pack');
    expect(template.headers()['content-type']).toBe('application/zip');

    // a user picks it from the switcher
    await page.context().clearCookies();
    await login(page, 'student2', DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Язык' }).click();
    await page.getByRole('menuitem', { name: 'Українська' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
    await expect(page.getByRole('link', { name: 'Головна' }).first()).toBeVisible();

    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/languages');
    await page.getByRole('button', { name: 'Удалить: Українська' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByRole('row', { name: /Українська/ })).toHaveCount(0);
  } finally {
    await sql(`DELETE FROM "LanguagePack" WHERE code = 'uk'`);
    await sql(`SELECT pg_notify('hubium_cache', 'languages')`);
    await sql(`UPDATE "User" SET locale = NULL WHERE username = 'student2'`);
  }
});
