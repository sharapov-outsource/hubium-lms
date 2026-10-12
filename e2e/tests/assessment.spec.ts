import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// Uses the seeded DEMO-PY course: its quiz (GIFT questions) and assignment.

const STUDENT = 'student3';
const STUDENT_NAME = 'Пётр Иванов';

async function demo() {
  const [row] = await sql<{ courseId: string; quizId: string; assignId: string }>(
    `SELECT c.id AS "courseId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'quiz' LIMIT 1) AS "quizId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'assign' LIMIT 1) AS "assignId"
       FROM "Course" c WHERE c."shortName" = 'DEMO-PY'`,
  );
  if (!row?.quizId || !row.assignId) throw new Error('Run pnpm db:seed first (demo assessment)');
  return row;
}

test.describe
  .serial('assessment: quiz, assignment, gradebook, question bank', () => {
    let ids: Awaited<ReturnType<typeof demo>>;

    test.beforeAll(async () => {
      ids = await demo();
      // fresh state for the student on every run
      const userSql = `(SELECT id FROM "User" WHERE username = '${STUDENT}')`;
      await sql(`DELETE FROM "QuizAttempt" WHERE "activityId" = $1 AND "userId" = ${userSql}`, [
        ids.quizId,
      ]);
      await sql(
        `DELETE FROM "AssignSubmission" WHERE "activityId" = $1 AND "userId" = ${userSql}`,
        [ids.assignId],
      );
      await sql(`DELETE FROM "AssignGrade" WHERE "activityId" = $1 AND "userId" = ${userSql}`, [
        ids.assignId,
      ]);
      await sql(
        `DELETE FROM "Grade" WHERE "userId" = ${userSql}
           AND "gradeItemId" IN (SELECT id FROM "GradeItem" WHERE "courseId" = $1)`,
        [ids.courseId],
      );
    });

    test('student takes the quiz and sees the review', async ({ page }) => {
      await login(page, STUDENT, DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}/a/${ids.quizId}`);
      await page.getByRole('button', { name: 'Начать попытку' }).click();
      await page.waitForURL(/attempt=/);
      await expect(page.getByRole('heading', { name: 'Вопрос 1' })).toBeVisible();
      await expect(page.getByText(/Осталось/)).toBeVisible();
      await expectAccessible(page);

      // page 1: multichoice, true/false, short answer
      await page.getByLabel('float', { exact: true }).check();
      await page.getByLabel('Верно', { exact: true }).check();
      await page.getByRole('textbox', { name: 'Ваш ответ' }).first().fill('print');
      await page.getByRole('button', { name: 'Далее' }).click();

      // page 2: numerical answer
      await expect(page.getByRole('heading', { name: 'Вопрос 4' })).toBeVisible();
      await page.getByRole('textbox', { name: 'Ваш ответ' }).first().fill('3');
      await page.getByRole('button', { name: 'Завершить попытку' }).first().click();
      await expect(page.getByText(/Изменить ответы будет нельзя/)).toBeVisible();
      await page.getByRole('button', { name: 'Завершить попытку' }).last().click();

      // 4 of 6 questions answered correctly
      await expect(page.getByText('Ваша оценка: 6.67 из 10')).toBeVisible();
      await expect(page.getByText('Попытка 1').first()).toBeVisible();
      await expectAccessible(page);
    });

    test('student submits the assignment', async ({ page }) => {
      await login(page, STUDENT, DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}/a/${ids.assignId}`);
      await page.locator('#assign-text').click();
      await page.keyboard.type('def add(a, b): return a + b');
      await page.getByRole('button', { name: 'Отправить на проверку' }).first().click();
      const confirm = page.getByRole('button', { name: 'Отправить на проверку' }).last();
      if (await confirm.isVisible()) await confirm.click();
      await expect(page.getByText('Отправлено на проверку').first()).toBeVisible();
    });

    test('teacher grades the submission', async ({ page }) => {
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}/a/${ids.assignId}`);
      const row = page.getByRole('row').filter({ hasText: STUDENT_NAME });
      await row.getByRole('link', { name: 'Оценить' }).click();
      await expect(page.getByText('def add(a, b)')).toBeVisible();
      await page.locator('#assign-grade').fill('8');
      await page.locator('#assign-feedback').click();
      await page.keyboard.type('Хорошо, но добавьте проверку типов.');
      await page.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
      await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
      await expectAccessible(page);
    });

    test('student sees the grade and feedback in the gradebook', async ({ page }) => {
      await login(page, STUDENT, DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}/grades`);
      const row = page.getByRole('row').filter({ hasText: 'Домашнее задание: калькулятор' });
      await expect(row).toContainText('8');
      await expect(row).toContainText('Хорошо, но добавьте проверку типов.');
      await expectAccessible(page);
    });

    test('teacher imports GIFT questions into the bank', async ({ page }) => {
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}/question-bank`);
      const name = `E2E-${Date.now().toString(36)}`;
      await page.locator('#f-gift').fill(`::${name}:: 2 + 2 = ? {=4 ~5 ~22}`);
      await page.locator('form:has(#f-gift) button[type=submit]').click();
      await expect(page.getByText('Импортировано вопросов: 1. Ошибок: 0.')).toBeVisible();
      await expect(page.getByText(name)).toBeVisible();
      await expectAccessible(page);
    });
  });
