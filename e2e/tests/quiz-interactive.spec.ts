import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// The interactive behaviour on the demo quiz, on a phone: a wrong answer shows the hint and
// locks the answer until "Try again"; the right one then earns the mark less the penalty.
// The teacher sees the steps in the review and the hints in the question editor.
// Question 4 (page 2) is "Деление": 6 / 2, the answer 3.

test('quiz: interactive with multiple tries', async ({ page }) => {
  const [row] = await sql<{
    courseId: string;
    quizId: string;
    userId: string;
    settings: object;
    questionId: string;
    penalty: string;
    hints: object;
  }>(
    `SELECT c.id AS "courseId", a.id AS "quizId", a.settings, u.id AS "userId",
            q.id AS "questionId", q.penalty, q.hints
       FROM "Course" c
       JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'quiz'
       JOIN "QuizSlot" s ON s."activityId" = a.id AND s.slot = 4
       JOIN "Question" q ON q.id = s."questionId"
       JOIN "User" u ON u.username = 'student3'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const { courseId, quizId, userId, settings, questionId, penalty, hints } = row!;
  const quiz = `/course/${courseId}/a/${quizId}`;
  // the demo course is shared by every spec: leave it as found
  const cleanup = async () => {
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [quizId, settings]);
    await sql(`UPDATE "Question" SET penalty = $2, hints = $3 WHERE id = $1`, [
      questionId,
      penalty,
      JSON.stringify(hints),
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
  await sql(
    `UPDATE "Activity" SET settings = settings || '{"behaviour": "interactive"}'::jsonb
      WHERE id = $1`,
    [quizId],
  );
  await sql(
    `UPDATE "Question" SET penalty = 0.25,
            hints = '[{"text": "<p>Разделите 6 на 2</p>", "clearWrong": false, "showNumCorrect": false}]'
      WHERE id = $1`,
    [questionId],
  );
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, 'student3', DEMO_PASSWORD);
    await page.goto(quiz);
    await page.getByRole('button', { name: 'Начать попытку' }).click();
    await page.waitForURL(/attempt=/);
    await page.getByRole('button', { name: 'Далее' }).click();

    const card = page.locator('#q-4');
    const answer = page.locator('#q4');
    await expect(card.getByText('Осталось 2 попытки')).toBeVisible();
    await answer.fill('2');
    await card.getByRole('button', { name: 'Проверить' }).click();
    await expect(card.getByText('Неверно')).toBeVisible();
    await expect(card.getByText('Разделите 6 на 2')).toBeVisible();
    await expect(card.getByText('Осталась 1 попытка')).toBeVisible();
    await expect(answer).toHaveAttribute('readonly', '');
    // the pressed button is gone: focus moves to the next step
    await expect(card.getByRole('button', { name: 'Ещё раз' })).toBeFocused();
    await expectAccessible(page);
    const sideScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(sideScroll).toBe(false);

    await card.getByRole('button', { name: 'Ещё раз' }).click();
    await expect(answer).not.toHaveAttribute('readonly', '');
    await expect(answer).toBeFocused();
    await answer.fill('3');
    await card.getByRole('button', { name: 'Проверить' }).click();
    await expect(card.getByText('Верно', { exact: true })).toBeVisible();
    await expect(card.getByText('Балл за вопрос: 0.75')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Проверить' })).toHaveCount(0);

    // the checked answer survives a reload
    await page.reload();
    await page
      .getByRole('navigation', { name: 'Навигация по вопросам' })
      .getByRole('button', { name: 'Вопрос 4' })
      .click();
    await expect(page.locator('#q-4').getByText('Балл за вопрос: 0.75')).toBeVisible();

    await page.getByRole('button', { name: 'Завершить попытку' }).first().click();
    await page.getByRole('button', { name: 'Завершить попытку' }).last().click();
    await page.waitForURL(/review=/);
    const review = page.url();

    await page.context().clearCookies();
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(review);
    // the question tried twice: its history holds the new try
    const steps = page.locator('details').filter({ hasText: 'Новая попытка' });
    await steps.getByText('История ответа').click();
    await expect(steps.getByText('Новая попытка')).toBeVisible();
    await expect(steps.getByText('Попытка завершена')).toBeVisible();
    await expectAccessible(page);

    await page.goto(`/course/${courseId}/question-bank/edit?id=${questionId}`);
    await expect(page.getByRole('heading', { name: 'Несколько попыток' })).toBeVisible();
    await expect(page.locator('#f-penalty')).toHaveText(/^25\s?%$/);
    await expect(page.getByRole('group', { name: 'Подсказка 1' })).toBeVisible();
    await expectAccessible(page);
  } finally {
    await cleanup();
  }
});
