import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const ADMIN = {
  login: process.env.SEED_ADMIN_EMAIL ?? 'admin@hubium.local',
  password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin12345!',
};
export const DEMO_PASSWORD = 'Demo12345!';

export async function login(page: Page, loginName: string, password: string) {
  await page.goto('/login');
  await page.locator('#login').fill(loginName);
  await page.locator('#password').fill(password);
  await page.locator('form button[type=submit]').click();
  await page.waitForURL(/\/dashboard/);
}

export async function logout(page: Page) {
  await page.context().clearCookies();
}

/** Fails on serious/critical axe violations. */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
    [],
  );
}
