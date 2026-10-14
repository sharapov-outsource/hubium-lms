import { expect, test } from '@playwright/test';
import { sql } from './db';
import { chooseOption, DEMO_PASSWORD, expectAccessible, login, pickDateTime } from './helpers';

// Team submissions on the demo assignment, two days late: a member sees the team and the
// penalty on a phone, accepts the statement and submits for the team; the teacher grades
// the whole team, then gives the group later dates and the penalty goes.

test('assignment: a team submits late, the teacher grades it and moves its dates', async ({
  page,
}) => {
  const [row] = await sql<{
    courseId: string;
    assignId: string;
    settings: object;
    groupingId: string | null;
    s1: string;
    s2: string;
  }>(
    `SELECT c.id AS "courseId", a.id AS "assignId", a.settings, a."groupingId",
            (SELECT id FROM "User" WHERE username = 'student1') AS s1,
            (SELECT id FROM "User" WHERE username = 'student2') AS s2
       FROM "Course" c
       JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'assign'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const { courseId, assignId, settings, groupingId, s1, s2 } = row!;
  const assign = `/course/${courseId}/a/${assignId}`;
  const cleanup = async () => {
    await sql(`UPDATE "Activity" SET settings = $2, "groupingId" = $3 WHERE id = $1`, [
      assignId,
      settings,
      groupingId,
    ]);
    await sql(
      `DELETE FROM "AssignSubmission" WHERE "activityId" = $1
         AND ("userId" IN ($2, $3) OR "groupId" IN (SELECT id FROM "Group" WHERE name = 'E2E команда'))`,
      [assignId, s1, s2],
    );
    await sql(`DELETE FROM "AssignGrade" WHERE "activityId" = $1 AND "userId" IN ($2, $3)`, [
      assignId,
      s1,
      s2,
    ]);
    await sql(
      `DELETE FROM "Grade" WHERE "userId" IN ($1, $2)
         AND "gradeItemId" IN (SELECT id FROM "GradeItem" WHERE "activityId" = $3)`,
      [s1, s2, assignId],
    );
    await sql(`DELETE FROM "Group" WHERE "courseId" = $1 AND name = 'E2E команда'`, [courseId]);
    await sql(`DELETE FROM "Grouping" WHERE "courseId" = $1 AND name = 'E2E команды'`, [courseId]);
  };
  await cleanup();
  const [team] = await sql<{ id: string }>(
    `INSERT INTO "Group" (id, "courseId", name, "updatedAt") VALUES (gen_random_uuid(), $1, 'E2E команда', now()) RETURNING id`,
    [courseId],
  );
  await sql(`INSERT INTO "GroupMember" ("groupId", "userId") VALUES ($1, $2), ($1, $3)`, [
    team!.id,
    s1,
    s2,
  ]);
  // teams come from the assignment's grouping: here just this one
  const [grouping] = await sql<{ id: string }>(
    `INSERT INTO "Grouping" (id, "courseId", name) VALUES (gen_random_uuid(), $1, 'E2E команды') RETURNING id`,
    [courseId],
  );
  await sql(`INSERT INTO "GroupingGroup" ("groupingId", "groupId") VALUES ($1, $2)`, [
    grouping!.id,
    team!.id,
  ]);
  await sql(`UPDATE "Activity" SET "groupingId" = $2 WHERE id = $1`, [assignId, grouping!.id]);
  await sql(`UPDATE "Activity" SET settings = settings || $2::jsonb WHERE id = $1`, [
    assignId,
    JSON.stringify({
      teamSubmission: true,
      requireStatement: true,
      latePenaltyPerDay: 10,
      latePenaltyCap: 50,
      dueAt: new Date(Date.now() - 2 * 86_400_000 + 3600_000).toISOString(),
      cutoffAt: null,
    }),
  ]);
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, 'student2', DEMO_PASSWORD);
    await page.goto(assign);
    await expect(page.getByText('Команда: E2E команда')).toBeVisible();
    await expect(page.getByText(/опоздание 2 дня, оценка снизится на 20%/)).toBeVisible();
    await expectAccessible(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    ).toBe(false);
    await page.locator('#assign-text').click();
    await page.keyboard.type('Работа нашей команды');
    await page.getByRole('button', { name: 'Отправить на проверку' }).first().click();
    const send = page.getByRole('button', { name: 'Отправить на проверку' }).last();
    // the statement first
    await expect(send).toBeDisabled();
    await page.getByLabel(/собственная работа нашей команды/).check();
    await send.click();
    await expect(page.getByText('Отправлено на проверку').first()).toBeVisible();

    // the teammate sees the team's work submitted
    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(assign);
    await expect(page.getByText('Работа нашей команды')).toBeVisible();
    await expect(page.getByText('Отправлено на проверку').first()).toBeVisible();

    // the teacher grades the whole team: the gradebook gets the grade less 20%
    await page.context().clearCookies();
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(assign);
    const studentRow = page.getByRole('row').filter({ hasText: 'E2E команда' }).first();
    await studentRow.getByRole('link', { name: 'Оценить' }).click();
    await expect(page.getByText(/Сдано с опозданием на 2 дня/)).toBeVisible();
    await expect(page.getByLabel(/Одинаково оценить всю команду/)).toBeChecked();
    await page.locator('#assign-grade').fill('8');
    await page.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
    await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
    await expectAccessible(page);
    await page.goto(assign);
    const teamRows = page.getByRole('row').filter({ hasText: 'E2E команда' });
    await expect(teamRows).toHaveCount(2);
    await expect(teamRows.first()).toContainText('−20%');
    await expect(teamRows.last()).toContainText('6.4 / 10');

    // later dates for the group: on time, no penalty
    await page.goto(`${assign}?tab=overrides`);
    await expectAccessible(page);
    await chooseOption(page.locator('#ao-who'), { label: 'Группа: E2E команда' });
    await pickDateTime(page, 'ao-due', new Date(Date.now() + 2 * 86_400_000));
    await page.getByRole('button', { name: 'Сохранить сроки' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Группа: E2E команда' })).toBeVisible();
    await page.goto(assign);
    await expect(page.getByRole('row').filter({ hasText: 'E2E команда' }).first()).toContainText(
      '8 / 10',
    );
  } finally {
    await cleanup();
  }
});
