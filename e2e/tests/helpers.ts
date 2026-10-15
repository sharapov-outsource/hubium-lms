import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

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

/**
 * Picks an option of a Hubium Select (a listbox, not a native <select>): by value, or by
 * visible label with `{ label }`.
 */
export async function chooseOption(trigger: Locator, option: string | { label: string }) {
  await trigger.click();
  const listbox = trigger.page().getByRole('listbox');
  const item =
    typeof option === 'string'
      ? listbox.locator(`[role="option"][data-value="${option}"]`)
      : listbox.getByRole('option', { name: option.label, exact: true });
  await item.click();
  await expect(listbox).toBeHidden();
}

/** Sets a Hubium date-time picker (trigger `#id`, time field `#id-time`) to a local time. */
export async function pickDateTime(page: Page, id: string, when: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  await page.locator(`#${id}`).click();
  const dialog = page.getByRole('dialog');
  const cell = dialog.locator(`[data-day="${day}"] button`).first();
  // the calendar opens on the current month; step forward until the day is shown
  for (let i = 0; i < 24 && !(await cell.isVisible()); i++) {
    await dialog.getByRole('button', { name: /next|следующ/i }).click();
  }
  await cell.click();
  await page.locator(`#${id}-time`).fill(`${pad(when.getHours())}:${pad(when.getMinutes())}`);
  await page.locator(`#${id}-time`).blur();
}

/** Fails (softly) when the page at `path` scrolls sideways; names the widest offender. */
export async function expectNoSideScroll(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  const overflow = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= vw + 1) return null;
    // the widest offender outside scroll containers, to make the failure readable
    const scrolls = (el: Element | null): boolean => {
      for (let e = el?.parentElement; e; e = e.parentElement) {
        const o = getComputedStyle(e).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
      }
      return false;
    };
    const bad = [...document.querySelectorAll('main *')].find(
      (el) => el.getBoundingClientRect().right > vw + 1 && !scrolls(el),
    );
    return `${document.documentElement.scrollWidth}px > ${vw}px: <${bad?.tagName.toLowerCase()} class="${bad?.className}">${bad?.textContent?.trim().slice(0, 40)}`;
  });
  expect.soft(overflow, path).toBeNull();
}
