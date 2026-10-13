import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// "Download my data" and the policy gate: a newly published mandatory policy must be
// accepted before the user can continue.

test.describe
  .serial('privacy', () => {
    test.afterAll(async () => {
      await sql(`DELETE FROM "Policy" WHERE key = 'e2e-terms'`);
    });

    test('user downloads their data', async ({ page }) => {
      await login(page, 'student1', DEMO_PASSWORD);
      await page.goto('/settings/privacy');
      await expectAccessible(page);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('link', { name: 'Скачать мои данные' }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^hubium-my-data-\d{4}-\d{2}-\d{2}\.json$/);
      const data = JSON.parse(await readFile((await download.path())!, 'utf8'));
      expect(data.user.username).toBe('student1');
      expect(data.enrolments.length).toBeGreaterThan(0);
      expect(data).toHaveProperty('modules');
    });

    test('admin publishes a mandatory policy and users must accept it', async ({ page }) => {
      await sql(`DELETE FROM "Policy" WHERE key = 'e2e-terms'`);
      await login(page, ADMIN.login, ADMIN.password);
      await page.goto('/admin/policies');
      await page.locator('#f-key-new').fill('e2e-terms');
      await page.locator('#f-name-ru-new').fill('Правила e2e');
      await page.getByRole('button', { name: 'Создать' }).click();
      await expect(page.getByRole('heading', { name: 'Правила e2e' })).toBeVisible();
      const card = page
        .locator('[class*="card"]', { has: page.getByRole('heading', { name: 'Правила e2e' }) })
        .first();
      await card.getByLabel('Текст (русский)').fill('## Правила\n\nНе списывать на тестах.');
      await card.getByRole('button', { name: 'Опубликовать новую версию' }).click();
      await expect(page.getByText('Новая версия опубликована')).toBeVisible();
      // the admin is the first to be asked
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/policies$/);
      await page.getByLabel('Я прочитал(а) и принимаю эти документы').check();
      await page.getByRole('button', { name: 'Продолжить' }).click();
      await expect(page).toHaveURL(/\/dashboard/);
      await logout(page);

      // sign in without the helper: it expects to land on the dashboard
      await page.goto('/login');
      await page.locator('#login').fill('student2');
      await page.locator('#password').fill(DEMO_PASSWORD);
      await page.locator('form button[type=submit]').click();
      await expect(page).toHaveURL(/\/policies$/);
      await expect(page.getByRole('heading', { name: 'Правила e2e' })).toBeVisible();
      await expect(page.getByText('Не списывать на тестах.')).toBeVisible();
      await expectAccessible(page);
      await expect(page.getByRole('button', { name: 'Продолжить' })).toBeDisabled();
      await page.getByLabel('Я прочитал(а) и принимаю эти документы').check();
      await page.getByRole('button', { name: 'Продолжить' }).click();
      await expect(page).toHaveURL(/\/dashboard/);
      const [n] = await sql<{ n: string }>(
        `SELECT count(*) AS n FROM "PolicyAcceptance" a JOIN "PolicyVersion" v ON v.id = a."versionId"
           JOIN "Policy" p ON p.id = v."policyId" WHERE p.key = 'e2e-terms'`,
      );
      expect(Number(n!.n)).toBe(2);
    });
  });
