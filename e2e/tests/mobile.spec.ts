import { expect, test } from '@playwright/test';
import { setSetting, sql } from './db';
import { ADMIN, DEMO_PASSWORD, expectNoSideScroll, login } from './helpers';

// Runs in the "mobile" project (a phone viewport): pages must not scroll sideways. Tab bars
// and tables scroll inside their own containers instead.

test.skip(({ isMobile }) => !isMobile, 'phone viewport only');

test('main pages fit a phone screen', async ({ page }) => {
  test.slow();
  const [c] = await sql<{
    id: string;
    forum: string;
    quiz: string;
    question: string;
    student: string;
  }>(
    `SELECT c.id,
       (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'forum'
          AND "deletedAt" IS NULL LIMIT 1) AS forum,
       (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'quiz'
          AND "deletedAt" IS NULL LIMIT 1) AS quiz,
       (SELECT q.id FROM "Question" q JOIN "QuestionCategory" qc ON qc.id = q."categoryId"
         WHERE qc."contextId" = c.id AND q.type = 'MULTICHOICE' LIMIT 1) AS question,
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
    `${course}/reset`,
    `${course}/import?q=DEMO`,
    `${course}/a/${c!.forum}`,
    `${course}/a/${c!.quiz}/edit`,
    `${course}/a/${c!.quiz}?tab=edit`,
    `${course}/question-bank/edit?id=${c!.question}`,
    '/settings/account',
    '/settings/security',
    '/admin',
    '/admin/users',
    `/admin/users/${c!.student}`,
    '/admin/categories',
    '/admin/cohorts',
    '/admin/roles',
    '/admin/profile-fields',
    '/admin/course-fields',
    '/admin/policies',
    '/admin/languages',
    '/admin/modules',
    '/admin/settings/general',
    '/admin/settings/maintenance',
    '/admin/environment',
    '/admin/tasks',
    '/admin/users/upload-relations',
  ])
    await expectNoSideScroll(page, path);

  await page.context().clearCookies();
  await login(page, 'student1', DEMO_PASSWORD);
  for (const path of ['/dashboard', course, `${course}/grades`, `/profile/${c!.student}`])
    await expectNoSideScroll(page, path);

  // a parent following student1
  await setSetting('mentors.enabled', true);
  try {
    await page.context().clearCookies();
    await login(page, 'parent', DEMO_PASSWORD);
    const mentee = `/mentees/${c!.student}`;
    for (const path of ['/mentees', mentee, `${mentee}/courses/${c!.id}`])
      await expectNoSideScroll(page, path);
  } finally {
    await sql(`DELETE FROM "SiteSetting" WHERE key = 'mentors.enabled'`);
    await sql(`SELECT pg_notify('hubium_cache', 'settings')`);
  }
});

test('sign-in and security administration fit 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  for (const path of [
    '/login',
    '/register',
    '/forgot-password',
    '/unlock-account?token=x',
    '/not-me?token=x',
  ])
    await expectNoSideScroll(page, path);
  await login(page, ADMIN.login, ADMIN.password);
  for (const path of [
    '/admin/settings/security',
    '/settings/security',
    '/admin/sso',
    '/admin/sso/new',
    '/admin/ldap',
    '/admin/users',
    '/admin/cohorts',
  ])
    await expectNoSideScroll(page, path);
});

test('every item of the main menu is reachable on a phone', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/dashboard');
  // the bottom bar holds the main few: the rest are behind the menu button
  await page.getByRole('button', { name: 'Открыть меню' }).click();
  const menu = page.getByRole('dialog').getByRole('navigation', { name: 'Основная навигация' });
  for (const item of ['Каталог', 'Отчёты', 'Администрирование'])
    await expect(menu.getByRole('link', { name: item })).toBeVisible();
  await menu.getByRole('link', { name: 'Каталог' }).click();
  await page.waitForURL(/\/catalog/);
  // the menu closes on the page it led to
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
