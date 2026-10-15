import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, login } from './helpers';

// Date pickers show and take times in the user's profile zone (the demo users have the
// site's, Europe/Moscow), as every other date on the page, even from a browser far away.
// West of UTC a deadline keeps the user's time and day: the evening before in New York.

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

test.describe('west of UTC', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('a learner in New York sees a deadline at their time and on their day', async ({ page }) => {
    const [row] = await sql<{
      courseId: string;
      assignId: string;
      name: string;
      settings: object;
      eventId: string;
      startsAt: Date;
      userId: string;
      zone: string | null;
    }>(
      `SELECT c.id AS "courseId", a.id AS "assignId", a.name, a.settings,
              e.id AS "eventId", e."startsAt", u.id AS "userId", u.timezone AS zone
         FROM "Course" c
         JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'assign'
         JOIN "CalendarEvent" e ON e."activityId" = a.id AND e.kind = 'DUE'
         JOIN "User" u ON u.username = 'student3'
        WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
    );
    const r = row!;
    // due at 03:30 UTC in two days: in New York still the evening of the day before
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + 2);
    due.setUTCHours(3, 30, 0, 0);
    const inNy = (o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('ru', { ...o, timeZone: 'America/New_York' }).format(due);
    const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(due);
    const utcDay = due.toISOString().slice(0, 10);
    expect(nyDay).not.toBe(utcDay);
    await sql(`UPDATE "Activity" SET settings = settings || $2::jsonb WHERE id = $1`, [
      r.assignId,
      JSON.stringify({ dueAt: due.toISOString() }),
    ]);
    await sql(`UPDATE "CalendarEvent" SET "startsAt" = $2 WHERE id = $1`, [r.eventId, due]);
    await sql(`UPDATE "User" SET timezone = 'America/New_York' WHERE id = $1`, [r.userId]);
    try {
      await login(page, 'student3', DEMO_PASSWORD);
      await page.goto(`/course/${r.courseId}/a/${r.assignId}`);
      await expect(page.getByText(inNy({ dateStyle: 'long', timeStyle: 'short' }))).toBeVisible();
      await page.goto('/dashboard');
      await expect(
        page.getByText(inNy({ dateStyle: 'medium', timeStyle: 'short' })).first(),
      ).toBeVisible();
      // the calendar puts it on the New York day, not on the next one
      const main = page.getByRole('main');
      await page.goto(`/calendar?view=day&date=${nyDay}`);
      await expect(main.getByText(r.name).first()).toBeVisible();
      await page.goto(`/calendar?view=day&date=${utcDay}`);
      await expect(main.getByText(r.name)).toHaveCount(0);
    } finally {
      await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [r.assignId, r.settings]);
      await sql(`UPDATE "CalendarEvent" SET "startsAt" = $2 WHERE id = $1`, [
        r.eventId,
        r.startsAt,
      ]);
      await sql(`UPDATE "User" SET timezone = $2 WHERE id = $1`, [r.userId, r.zone]);
    }
  });
});
