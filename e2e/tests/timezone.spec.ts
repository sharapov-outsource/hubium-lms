import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, login } from './helpers';

// Date pickers show and take times in the user's profile zone (the demo users have the
// site's, Europe/Moscow), as every other date on the page, even from a browser far away.

test.use({ timezoneId: 'Pacific/Auckland' });

test('date pickers use the profile time zone, not the browser’s', async ({ page }) => {
  const [row] = await sql<{ courseId: string; assignId: string; s1: string; settings: object }>(
    `SELECT c.id AS "courseId", a.id AS "assignId", a.settings,
            (SELECT id FROM "User" WHERE username = 'student1') AS s1
       FROM "Course" c JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'assign'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const { courseId, assignId, s1, settings } = row!;
  const cleanup = async () => {
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [assignId, settings]);
    await sql(`DELETE FROM "AssignOverride" WHERE "activityId" = $1 AND "userId" = $2`, [
      assignId,
      s1,
    ]);
  };
  // due at 20:59 UTC: 23:59 in Moscow, 09:59 the next morning in Auckland
  await sql(`UPDATE "Activity" SET settings = settings || $2::jsonb WHERE id = $1`, [
    assignId,
    JSON.stringify({ dueAt: '2027-03-10T20:59:00.000Z' }),
  ]);
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`/course/${courseId}/a/${assignId}?grade=${s1}`);
    await expect(page.locator('#assign-ext-time')).toHaveValue('23:59');
    // an extension picked as 18:30 is 18:30 in Moscow
    await page.locator('#assign-ext-time').fill('18:30');
    await page.locator('#assign-ext-time').blur();
    await page.getByRole('button', { name: 'Продлить срок' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();
    await expect
      .poll(async () => {
        const [o] = await sql<{ dueAt: Date }>(
          `SELECT "dueAt" FROM "AssignOverride" WHERE "activityId" = $1 AND "userId" = $2`,
          [assignId, s1],
        );
        return o?.dueAt.toISOString();
      })
      .toBe('2027-03-10T15:30:00.000Z');
  } finally {
    await cleanup();
  }
});
