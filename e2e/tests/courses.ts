import { expect, type Page } from '@playwright/test';

// Steps that scenarios of activity modules share: a course of their own, open for
// self-enrolment, and adding an activity to it through the activity picker.

/** Creates a course as the signed-in user and returns its id. */
export async function newCourse(page: Page, fullName: string, shortName: string) {
  await page.goto('/course/new');
  await page.locator('#f-fullName').fill(fullName);
  await page.locator('#f-shortName').fill(shortName);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.waitForURL(/\/course\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname.split('/')[2]!;
}

/** Lets learners enrol themselves without a key. */
export async function openSelfEnrolment(page: Page, courseId: string) {
  await page.goto(`/course/${courseId}/enrolment`);
  await page.locator('#self-enabled').check();
  await page.getByRole('button', { name: 'Сохранить' }).first().click();
  await expect(page.getByText('Сохранено').first()).toBeVisible();
}

/** Signed-in learner enrols in the course from its description page. */
export async function selfEnrol(page: Page, courseId: string) {
  await page.goto(`/course/${courseId}`);
  await page.getByRole('button', { name: 'Записаться' }).click();
  await page.waitForLoadState('networkidle');
}

/**
 * Adds an activity of the type named `type` (as in the picker) to the first section,
 * filling the form with `fill`, and returns its id.
 */
export async function addActivity(
  page: Page,
  courseId: string,
  type: RegExp,
  name: string,
  fill?: () => Promise<void>,
) {
  await page.goto(`/course/${courseId}?edit=1`);
  await page.getByRole('button', { name: 'Добавить элемент' }).first().click();
  await page.getByRole('dialog').getByRole('link', { name: type }).click();
  await page.waitForURL(/\/a\/new\?module=/);
  await page.locator('#f-name').fill(name);
  await fill?.();
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.waitForURL(/\?edit=1/);
  const href = await page.getByRole('link', { name, exact: true }).getAttribute('href');
  return href!.split('/a/')[1]!.split(/[?#]/)[0]!;
}
