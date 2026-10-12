import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// The admin registers an LTI 1.3 tool; a teacher adds it to a course; opening the
// activity starts the OIDC login initiation towards the tool.

test('LTI tool registration and launch initiation', async ({ page }) => {
  const name = `Tool ${Date.now().toString(36)}`;
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/lti');
  await expect(page.getByText('/api/mod/lti/jwks')).toBeVisible();
  await page.locator('#f-name').fill(name);
  await page.locator('#f-oidcLoginUrl').fill('https://tool.example/login');
  await page.locator('#f-targetLinkUri').fill('https://tool.example/launch');
  await page.locator('#f-redirectUris').fill('https://tool.example/launch');
  await page.locator('#f-jwksUrl').fill('https://tool.example/jwks');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expectAccessible(page);
  await logout(page);

  const [c] = await sql<{ id: string }>(`SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`);
  const [section] = await sql<{ id: string }>(
    `SELECT id FROM "CourseSection" WHERE "courseId" = $1 ORDER BY rank LIMIT 1`,
    [c!.id],
  );
  await login(page, 'teacher', DEMO_PASSWORD);
  await page.goto(`/course/${c!.id}/a/new?module=lti&section=${section!.id}`);
  await page.locator('#f-name').fill('Онлайн-тренажёр');
  await page.locator('#lti-tool').selectOption({ label: name });
  await page.getByRole('button', { name: /^Создать$/ }).click();
  await page.waitForURL(/\?edit=1/);
  const [act] = await sql<{ id: string }>(
    `SELECT id FROM "Activity" WHERE "courseId" = $1 AND "moduleKey" = 'lti' ORDER BY "createdAt" DESC LIMIT 1`,
    [c!.id],
  );
  // the launch endpoint redirects to the tool's OIDC login with signed hints
  const r = await page.request.get(`/api/mod/lti/launch/${act!.id}`, { maxRedirects: 0 });
  expect(r.status()).toBe(302);
  const login2 = new URL(r.headers().location!);
  expect(login2.origin).toBe('https://tool.example');
  expect(login2.searchParams.get('lti_message_hint')).toMatch(/^[\w-]+\.[\w-]+$/);
  await page.route('https://tool.example/**', (route) => route.fulfill({ body: 'tool' }));
  await page.goto(`/course/${c!.id}/a/${act!.id}`);
  await expect(page.locator(`iframe[title="${name}"]`)).toHaveAttribute(
    'src',
    `/api/mod/lti/launch/${act!.id}`,
  );
});
