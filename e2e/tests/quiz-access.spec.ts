import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// A quiz password and sequential navigation on the demo quiz: the teacher
// sees the access settings, a student needs the password and cannot go back a page.
// The demo quiz has six questions, three to a page.

test('quiz: password and sequential navigation', async ({ page }) => {
  const [row] = await sql<{ courseId: string; quizId: string; userId: string; settings: object }>(
    `SELECT c.id AS "courseId", a.id AS "quizId", a.settings, u.id AS "userId"
       FROM "Course" c
       JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'quiz'
       JOIN "User" u ON u.username = 'student3'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const { courseId, quizId, userId, settings } = row!;
  const quiz = `/course/${courseId}/a/${quizId}`;
  // the demo course is shared by every spec: leave it as found
  const cleanup = async () => {
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [quizId, settings]);
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
  await sql(
    `UPDATE "Activity"
        SET settings = settings || '{"password": "Ключ-2026", "navMethod": "sequential"}'::jsonb
      WHERE id = $1`,
    [quizId],
  );
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`${quiz}/edit`);
    await expect(page.getByRole('group', { name: 'Доступ' })).toBeVisible();
    await expect(page.locator('#qs-password')).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Показать пароль' }).click();
    await expect(page.locator('#qs-password')).toHaveValue('Ключ-2026');
    await expectAccessible(page);
    await page.goto(`${quiz}?tab=edit`);
    await expect(page.getByText('Страница 2')).toBeVisible();

    await page.context().clearCookies();
    await login(page, 'student3', DEMO_PASSWORD);
    await page.goto(quiz);
    await expectAccessible(page);
    await page.getByLabel('Пароль теста').fill('ключ-2026');
    await page.getByRole('button', { name: 'Начать попытку' }).click();
    await expect(page.getByText('Неверный пароль теста')).toBeVisible();
    await page.getByLabel('Пароль теста').fill('Ключ-2026');
    await page.getByRole('button', { name: 'Начать попытку' }).click();
    await page.waitForURL(/attempt=/);

    // page by page: no way back, other pages out of reach
    await expect(page.getByText('Страницы идут по порядку')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Назад' })).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Навигация по вопросам' });
    await expect(nav.getByRole('button', { name: 'Вопрос 4' })).toBeDisabled();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(nav.getByRole('button', { name: 'Вопрос 4' })).toBeEnabled();
    await expect(nav.getByRole('button', { name: 'Вопрос 1' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Далее' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Завершить попытку' }).first().click();
    await page.getByRole('button', { name: 'Завершить попытку' }).last().click();
    await expect(page.getByText(/Ваша оценка/)).toBeVisible();
  } finally {
    await cleanup();
  }
});
