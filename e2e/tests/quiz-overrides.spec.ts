import { expect, test } from '@playwright/test';
import { sql } from './db';
import { chooseOption, DEMO_PASSWORD, expectAccessible, login } from './helpers';

// The teacher gives one student extra attempts on the demo quiz; the student uses one; the
// teacher dry-runs a regrade of the results.

test('quiz: a per-student setting and a regrade dry run', async ({ page }) => {
  const [row] = await sql<{ courseId: string; quizId: string; userId: string; name: string }>(
    `SELECT c.id AS "courseId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'quiz' LIMIT 1) AS "quizId",
            u.id AS "userId", u.name
       FROM "Course" c, "User" u WHERE c."shortName" = 'DEMO-PY' AND u.username = 'student2'`,
  );
  const { courseId, quizId, userId, name } = row!;
  const quiz = `/course/${courseId}/a/${quizId}`;
  // the demo course is shared by every spec: leave it as found
  const cleanup = async () => {
    await sql(`DELETE FROM "QuizOverride" WHERE "activityId" = $1 AND "userId" = $2`, [
      quizId,
      userId,
    ]);
    await sql(`DELETE FROM "QuizAttempt" WHERE "activityId" = $1 AND "userId" = $2`, [
      quizId,
      userId,
    ]);
    await sql(
      `DELETE FROM "Grade" WHERE "userId" = $1
         AND "gradeItemId" IN (SELECT id FROM "GradeItem" WHERE "activityId" = $2)`,
      [userId, quizId],
    );
  };
  await cleanup();
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`${quiz}?tab=overrides`);
    await expectAccessible(page);
    await chooseOption(page.locator('#ov-who'), { label: name });
    await page.locator('#ov-attempts').fill('5');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('5');

    await page.context().clearCookies();
    await login(page, 'student2', DEMO_PASSWORD);
    await page.goto(quiz);
    await page.getByRole('button', { name: 'Начать попытку' }).click();
    await page.waitForURL(/attempt=/);
    // the finish button is on the last page
    const next = page.getByRole('button', { name: 'Далее' });
    while (await next.isVisible()) {
      await next.click();
      await page.waitForLoadState('networkidle');
    }
    await page.getByRole('button', { name: 'Завершить попытку' }).first().click();
    await page.getByRole('button', { name: 'Завершить попытку' }).last().click();
    await expect(page.getByText(/Ваша оценка/)).toBeVisible();

    await page.context().clearCookies();
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`${quiz}?tab=results`);
    await page.getByRole('button', { name: 'Пробная переоценка' }).click();
    await expect(page.getByText(/Изменится попыток: \d+ из \d+/)).toBeVisible();
    await expectAccessible(page);
  } finally {
    await cleanup();
  }
});
