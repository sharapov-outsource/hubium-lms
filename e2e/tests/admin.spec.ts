import { expect, test } from '@playwright/test';
import { setSetting } from './db';
import { ADMIN, chooseOption, expectAccessible, login } from './helpers';

const stamp = Date.now();

test('admin creates a user, assigns a site role, the user signs in', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/users');
  await expectAccessible(page);
  await page.getByRole('link', { name: /Новый пользователь|New user/ }).click();
  await page.locator('#f-firstName').fill('Борис');
  await page.locator('#f-lastName').fill('Новиков');
  await page.locator('#f-email').fill(`boris${stamp}@example.com`);
  await page.locator('#f-username').fill(`boris${stamp}`);
  await page.locator('#f-password').fill('Password123');
  await page.getByRole('button', { name: /Создать|Create/ }).click();
  await page.waitForURL(/\/admin\/users\/[0-9a-f-]{36}/);
  await expect(page.getByText(/Пользователь создан|User created/)).toBeVisible();
  await page.getByLabel(/Создатель курсов|Course creator/).check();
  await expect(page.getByText(/Сохранено|Saved/).first()).toBeVisible();

  await page.context().clearCookies();
  await login(page, `boris${stamp}`, 'Password123');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Борис');
});

test('role matrix change applies and permission checker explains it', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/roles');
  await page.getByRole('link', { name: /^Студент$|^Student$/ }).click();
  const select = page.getByLabel('grade:viewall', { exact: true });
  await chooseOption(select, 'ALLOW');
  await expect(page.getByText(/Сохранено|Saved/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('grade:viewall', { exact: true })).toHaveAttribute(
    'data-value',
    'ALLOW',
  );
  await chooseOption(page.getByLabel('grade:viewall', { exact: true }), 'INHERIT');
  await expect(page.getByText(/Сохранено|Saved/).first()).toBeVisible();

  await page.goto('/admin/permissions?user=manager%40hubium.local&cap=user%3Acreate');
  await expect(page.getByText(/Разрешено|Allowed/).first()).toBeVisible();
  await page.goto('/admin/permissions?user=student1&cap=user%3Acreate');
  await expect(page.getByText(/Запрещено|Denied/).first()).toBeVisible();
});

test('branding: low-contrast colour is adjusted and applied', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/settings/branding');
  await page.locator('#accent').fill('#facc15');
  await expect(page.getByText(/скорректирован|adjusted/)).toBeVisible();
  await page.getByRole('button', { name: /Сохранить|Save/ }).click();
  await page.waitForLoadState('networkidle');
  await page.reload();
  const css = await page.locator('#hubium-brand').innerHTML();
  const light = css.slice(0, css.indexOf('.dark'));
  expect(light).toContain('--accent:#');
  expect(light).not.toContain('--accent:#facc15');
  await setSetting('branding.accent', '#4f46e5');
});

test('manager sees users admin but not site settings', async ({ page }) => {
  await login(page, 'manager', 'Demo12345!');
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const res = await page.goto('/admin/settings/general');
  expect(res?.status()).toBe(403);
});

test('mobile layout shows bottom navigation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await login(page, 'student1', 'Demo12345!');
  const bottom = page.locator('nav.fixed');
  await expect(bottom).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
