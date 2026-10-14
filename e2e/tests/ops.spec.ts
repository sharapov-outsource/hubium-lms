import { expect, test } from '@playwright/test';
import { setSetting, sql } from './db';
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

test('Administration → Tasks runs a task now and retries a failed run', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/tasks');
  await expectAccessible(page);
  // the heartbeat runs every minute
  await expect(page.getByRole('listitem', { name: 'Пульс воркера' })).toContainText('Готово');

  const cleanup = page.getByRole('listitem', { name: 'Удаление истёкших сеансов' });
  await cleanup.getByRole('button', { name: /Запустить сейчас/ }).click();
  await expect(page.getByText('Задача поставлена в очередь').first()).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await sql<{ n: number }>(
            `SELECT count(*)::int AS n FROM pgboss.job
             WHERE name = 'auth.sessions.cleanup' AND state = 'completed' AND retry_limit = 0`,
          )
        )[0]!.n,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // a failed run goes back to the worker
  const [failed] = await sql<{ id: string }>(
    `INSERT INTO pgboss.job (name, state, output, retry_limit, started_on, completed_on)
     VALUES ('webhooks.prune', 'failed', '{"message":"Receiver gone (e2e)"}', 0, now(), now())
     RETURNING id::text`,
  );
  await page.goto('/admin/tasks?name=webhooks.prune&state=failed');
  await expect(page.getByText('Receiver gone (e2e)').first()).toBeVisible();
  await page.getByRole('button', { name: 'Повторить' }).first().click();
  await expect(page.getByText('Задача поставлена в очередь').first()).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await sql<{ state: string }>(`SELECT state::text FROM pgboss.job WHERE id = $1`, [
            failed!.id,
          ])
        )[0]?.state,
      { timeout: 30_000 },
    )
    .toBe('completed');
});
