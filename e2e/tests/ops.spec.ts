import { expect, test } from '@playwright/test';
import { setSetting } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, login } from './helpers';

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

test('maintenance mode lets only administrators in', async ({ page, request }) => {
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/settings/maintenance');
    await expectAccessible(page);
    await page.getByLabel('Включить режим обслуживания').check();
    await page.getByLabel('Сообщение для пользователей').fill('Обновляем Hubium');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();
    // the administrator keeps working, reminded on every page
    await page.goto('/dashboard');
    await expect(page.getByText(/Включён режим обслуживания/)).toBeVisible();

    // everyone else gets a 503 page (web servers notice within seconds), the API a 503 answer
    await expect
      .poll(async () => (await request.get('/dashboard', { maxRedirects: 0 })).status(), {
        timeout: 20_000,
      })
      .toBe(503);
    const res = await request.get('/dashboard');
    expect(res.headers()['retry-after']).toBe('600');
    expect(await res.text()).toContain('Обновляем Hubium');
    const api = await request.get('/api/v1/me');
    expect(api.status()).toBe(503);
    expect(await api.json()).toMatchObject({ code: 'MAINTENANCE', message: 'Обновляем Hubium' });
    // signing in stays open, but a learner who signs in still waits
    await page.context().clearCookies();
    await page.goto('/login');
    await page.locator('#login').fill('student1');
    await page.locator('#password').fill(DEMO_PASSWORD);
    await page.locator('form button[type=submit]').click();
    await expect(page.getByRole('heading', { name: 'Сайт на обслуживании' })).toBeVisible();
    await expect(page.getByText('Обновляем Hubium')).toBeVisible();
  } finally {
    await setSetting('maintenance.enabled', false);
    await expect
      .poll(async () => (await request.get('/api/v1/me')).status(), { timeout: 20_000 })
      .toBe(401);
  }
});
