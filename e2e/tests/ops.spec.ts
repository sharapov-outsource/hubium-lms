import { expect, test } from '@playwright/test';
import { ADMIN, expectAccessible, login } from './helpers';

// Admin → Environment runs live checks; the metrics endpoint stays closed without a token.

test('environment checks show a running worker', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await expect
    .poll(
      async () => {
        await page.goto('/admin/environment');
        return page.getByRole('row', { name: /Фоновый обработчик/ }).innerText();
      },
      { timeout: 90_000, intervals: [5_000] },
    )
    .toContain('Норма');
  await expect(page.getByRole('row', { name: /Хранилище файлов/ }).first()).toContainText('Норма');
  await expectAccessible(page);
});

test('metrics endpoint is disabled without a token', async ({ request }) => {
  expect((await request.get('/api/metrics')).status()).toBe(404);
});
