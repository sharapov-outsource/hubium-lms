import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, DEMO_PASSWORD, login } from './helpers';

// Runs in the "mobile" project (a phone viewport): pages must not scroll sideways. Tab bars
// and tables scroll inside their own containers instead.

test.skip(({ isMobile }) => !isMobile, 'phone viewport only');

async function expectNoSideScroll(page: import('@playwright/test').Page, path: string) {
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

test('main pages fit a phone screen', async ({ page }) => {
  test.slow();
  const [c] = await sql<{ id: string; forum: string; student: string }>(
    `SELECT c.id,
       (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'forum'
          AND "deletedAt" IS NULL LIMIT 1) AS forum,
       (SELECT id FROM "User" WHERE username = 'student1') AS student
     FROM "Course" c WHERE c."shortName" = 'DEMO-PY'`,
  );
  const course = `/course/${c!.id}`;
  await login(page, ADMIN.login, ADMIN.password);
  for (const path of [
    '/dashboard',
    '/my-courses',
    '/catalog',
    '/calendar',
    '/messages',
    '/notifications',
    course,
    `${course}?edit=1`,
    `${course}/participants`,
    `${course}/groups`,
    `${course}/grades`,
    `${course}/completion`,
    `${course}/reports`,
    `${course}/enrolment`,
    `${course}/permissions`,
    `${course}/settings`,
    `${course}/a/${c!.forum}`,
    '/settings/account',
    '/settings/security',
    '/admin',
    '/admin/users',
    `/admin/users/${c!.student}`,
    '/admin/categories',
    '/admin/cohorts',
    '/admin/roles',
    '/admin/profile-fields',
    '/admin/policies',
    '/admin/languages',
    '/admin/modules',
    '/admin/settings/general',
    '/admin/environment',
  ])
    await expectNoSideScroll(page, path);

  await page.context().clearCookies();
  await login(page, 'student1', DEMO_PASSWORD);
  for (const path of ['/dashboard', course, `${course}/grades`, `/profile/${c!.student}`])
    await expectNoSideScroll(page, path);
});
