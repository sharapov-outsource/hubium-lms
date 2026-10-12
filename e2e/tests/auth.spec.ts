import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, login } from './helpers';

test('login page is accessible', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAccessible(page);
});

test('wrong password shows an error', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#login').fill(ADMIN.login);
  await page.locator('#password').fill('wrong-password');
  await page.locator('form button[type=submit]').click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('admin signs in by email and sees admin entry', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Site');
  await expect(
    page
      .getByRole('navigation')
      .getByRole('link', { name: /Администрирование|Administration/ })
      .first(),
  ).toBeVisible();
  await expectAccessible(page);
});

test('student signs in by username; no admin link', async ({ page }) => {
  await login(page, 'student1', DEMO_PASSWORD);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Иван');
  await expect(page.getByRole('link', { name: /Администрирование|Administration/ })).toHaveCount(0);
});

test('protected pages redirect to login', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
});

test('language switch persists', async ({ page }) => {
  await sql(`UPDATE "User" SET locale = NULL WHERE username = 'student2'`);
  await login(page, 'student2', DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Язык' }).click();
  await page.getByRole('menuitem', { name: 'English' }).click();
  await expect(page.getByRole('link', { name: 'Home' }).first()).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Language' }).click();
  await page.getByRole('menuitem', { name: 'Русский' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect
    .poll(
      async () =>
        (await sql<{ locale: string }>(`SELECT locale FROM "User" WHERE username='student2'`))[0]
          ?.locale,
    )
    .toBe('ru');
});

test('dark theme persists', async ({ page }) => {
  await sql(`UPDATE "User" SET theme = NULL WHERE username = 'student3'`);
  await login(page, 'student3', DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Тема' }).click();
  await page.getByRole('menuitem', { name: 'Тёмная' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expectAccessible(page);
});
