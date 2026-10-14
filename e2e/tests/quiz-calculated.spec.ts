import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// A calculated question made in the editor (formula, datasets generated, the answers of
// the variants previewed) and answered on a phone with the values the attempt drew. It
// goes on a third page of the demo quiz for the test and is removed afterwards.

test('quiz: a calculated question from the editor to the review', async ({ page }) => {
  const [row] = await sql<{
    courseId: string;
    quizId: string;
    userId: string;
    categoryId: string;
    settings: object;
  }>(
    `SELECT c.id AS "courseId", a.id AS "quizId", a.settings, u.id AS "userId",
            (SELECT id FROM "QuestionCategory" WHERE "contextId" = c.id ORDER BY "sortOrder" LIMIT 1) AS "categoryId"
       FROM "Course" c
       JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'quiz'
       JOIN "User" u ON u.username = 'student1'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const { courseId, quizId, userId, categoryId, settings } = row!;
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
    await sql(`DELETE FROM "QuizSlot" WHERE "activityId" = $1 AND slot > 6`, [quizId]);
    await sql(`DELETE FROM "Question" WHERE name = 'E2E calc' AND "categoryId" = $1`, [categoryId]);
  };
  await cleanup();
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(
      `/course/${courseId}/question-bank/edit?type=CALCULATED&category=${categoryId}`,
    );
    await page.getByLabel('Название').fill('E2E calc');
    await page.getByRole('textbox', { name: 'Текст вопроса' }).fill('Сколько будет {a} + {b}?');
    await page.getByLabel('Формула ответа 1').fill('{a} + {b}');
    await expect(page.getByRole('cell', { name: '{a}', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '{b}', exact: true })).toBeVisible();
    // a broken formula says what is wrong
    await page.getByLabel('Формула ответа 1').fill('{a} +');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await page.getByLabel('Формула ответа 1').fill('{a} + {b}');
    await page.getByLabel('Знаков {a}').fill('0');
    await page.getByLabel('Знаков {b}').fill('0');
    await page.getByRole('button', { name: 'Сгенерировать 10 значений' }).click();
    await expect(page.getByText('10 вариантов')).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForURL(/question-bank\?category=/);
    const [q] = await sql<{ id: string }>(
      `SELECT id FROM "Question" WHERE name = 'E2E calc' AND "categoryId" = $1`,
      [categoryId],
    );
    await sql(
      `INSERT INTO "QuizSlot" (id, "activityId", page, slot, kind, "questionId", "maxMark")
       VALUES (gen_random_uuid(), $1, 3, 7, 'FIXED', $2, 1)`,
      [quizId, q!.id],
    );

    await page.context().clearCookies();
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(`/course/${courseId}/a/${quizId}`);
    await page.getByRole('button', { name: 'Начать попытку' }).click();
    await page.waitForURL(/attempt=/);
    await page
      .getByRole('navigation', { name: 'Навигация по вопросам' })
      .getByRole('button', { name: 'Вопрос 7' })
      .click();
    const card = page.locator('#q-7');
    const text = await card.getByText(/Сколько будет/).innerText();
    const [, a, b] = /Сколько будет (\d+) \+ (\d+)\?/.exec(text) ?? [];
    expect(a && b).toBeTruthy();
    await page.locator('#q7').fill(String(Number(a) + Number(b)));
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Завершить попытку' }).first().click();
    await page.getByRole('button', { name: 'Завершить попытку' }).last().click();
    await page.waitForURL(/review=/);
    await expect(page.getByText(`Сколько будет ${a} + ${b}?`)).toBeVisible();
    await expect(page.getByText(String(Number(a) + Number(b))).first()).toBeVisible();
  } finally {
    await cleanup();
  }
});
