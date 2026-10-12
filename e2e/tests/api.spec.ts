import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// A student creates a personal access token, calls the REST API with it and revokes it.

test('API token lifecycle and REST access', async ({ page, request }) => {
  await login(page, 'student1', DEMO_PASSWORD);
  await page.goto('/settings/api-tokens');
  await expect(page.getByRole('heading', { name: 'Новый токен' })).toBeVisible();
  await expectAccessible(page);
  const name = `script-${Date.now().toString(36)}`;
  await page.locator('#f-name').fill(name);
  await page.getByRole('button', { name: 'Создать токен' }).click();
  const token = (await page.getByTestId('new-token').textContent())!.trim();
  expect(token).toMatch(/^hub_[\w-]{20,}$/);

  const auth = { Authorization: `Bearer ${token}` };
  const me = await request.get('/api/v1/me', { headers: auth });
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ username: 'student1' });
  const courses = await request.get('/api/v1/courses', { headers: auth });
  expect(
    ((await courses.json()) as { items: { shortName: string }[] }).items.map((c) => c.shortName),
  ).toContain('DEMO-PY');
  // read-only token can't write
  const write = await request.post('/api/v1/notifications/read', { headers: auth, data: {} });
  expect(write.status()).toBe(403);

  await page.reload();
  const row = page.getByRole('row', { name: new RegExp(name) });
  await row.getByRole('button', { name: 'Отозвать' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
  await expect(row.getByText('Отозван')).toBeVisible();
  expect((await request.get('/api/v1/me', { headers: auth })).status()).toBe(401);

  // the spec and docs are public
  expect((await request.get('/api/v1/openapi.json')).status()).toBe(200);
});
