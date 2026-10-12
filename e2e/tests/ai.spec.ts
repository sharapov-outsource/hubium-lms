import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// AI features on the seeded DEMO-PY course with the offline mock provider:
// admin settings, the course tutor, question generation and the grading assistant.

const STUDENT = 'student2';

async function demo() {
  const [row] = await sql<{ courseId: string; assignId: string; studentId: string }>(
    `SELECT c.id AS "courseId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'assign' LIMIT 1) AS "assignId",
            (SELECT id FROM "User" WHERE username = '${STUDENT}') AS "studentId"
       FROM "Course" c WHERE c."shortName" = 'DEMO-PY'`,
  );
  const [ai] = await sql<{ n: string }>(`SELECT count(*) AS n FROM "AiProvider"`);
  if (!row?.assignId || Number(ai?.n) === 0) throw new Error('Run pnpm db:seed first (demo AI)');
  return row;
}

test.describe
  .serial('AI', () => {
    let ids: Awaited<ReturnType<typeof demo>>;

    test.beforeAll(async () => {
      ids = await demo();
      await sql(`DELETE FROM "AiConsent"`);
      await sql(`DELETE FROM "TutorConversation" WHERE "courseId" = $1`, [ids.courseId]);
      await sql(`DELETE FROM "AiUsage"`);
      await sql(
        `UPDATE "QuizAttempt" SET state = 'FINISHED' WHERE "userId" = $1 AND state = 'IN_PROGRESS'`,
        [ids.studentId],
      );
      await sql(`DELETE FROM "AssignSubmission" WHERE "activityId" = $1 AND "userId" = $2`, [
        ids.assignId,
        ids.studentId,
      ]);
      await sql(
        `INSERT INTO "AssignSubmission" (id, "activityId", "userId", status, "onlineText", "submittedAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, 'SUBMITTED', $3, now(), now())`,
        [
          ids.assignId,
          ids.studentId,
          '<p>a = float(input()); b = float(input()); print(a + b, a - b, a * b). Программа читает два числа и печатает сумму, разность и произведение.</p>',
        ],
      );
    });

    test('admin sees AI settings and usage', async ({ page }) => {
      await login(page, ADMIN.login, ADMIN.password);
      await page.goto('/admin/ai');
      await expect(page.getByRole('heading', { name: 'Искусственный интеллект' })).toBeVisible();
      await expect(page.getByText('Демо-провайдер (без ключа)').first()).toBeVisible();
      await expect(page.getByLabel('Включить AI-функции на сайте')).toBeChecked();
      await expectAccessible(page);
    });

    test('student asks the course tutor', async ({ page }) => {
      await login(page, STUDENT, DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}`);
      await page.getByRole('link', { name: 'AI-тьютор' }).click();
      await page.getByRole('button', { name: 'Принимаю и продолжаю' }).click();
      await expect(page.getByText(/Задайте вопрос по материалам курса/)).toBeVisible();
      await expectAccessible(page);
      await page.getByLabel('Ваш вопрос по курсу…').fill('Как объявить функцию в Python?');
      await page.getByRole('button', { name: 'Отправить' }).click();
      const answer = page.locator('ol[aria-live] li').nth(1);
      await expect(answer).toContainText('По материалам курса [1]');
      await expect(answer.getByRole('link', { name: /\[1\]/ })).toBeVisible();
      await answer.getByRole('button', { name: 'Полезный ответ', exact: true }).click();
      await expect(
        answer.getByRole('button', { name: 'Полезный ответ', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      // history survives a reload
      await page.reload();
      await expect(page.getByRole('link', { name: /Как объявить функцию/ })).toBeVisible();
      const [usage] = await sql<{ n: string }>(
        `SELECT count(*) AS n FROM "AiUsage" WHERE feature = 'TUTOR' AND status = 'OK'`,
      );
      expect(Number(usage!.n)).toBeGreaterThan(0);
      await logout(page);
    });

    test('teacher generates questions and reviews the drafts', async ({ page }) => {
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}/question-bank`);
      await page.getByRole('link', { name: 'Сгенерировать с AI' }).click();
      await page.getByRole('button', { name: 'Принимаю и продолжаю' }).click();
      await page.getByLabel('Функции и аргументы').check();
      await page.getByLabel('Верно/неверно').check();
      await page.locator('#qg-count').fill('2');
      await expectAccessible(page);
      await page.getByRole('button', { name: 'Сгенерировать' }).click();
      await expect(page.getByText('Создано черновиков: 2. Отметьте, какие оставить.')).toBeVisible({
        timeout: 30_000,
      });
      await page.getByLabel('Оставить').nth(1).uncheck();
      await page.getByRole('button', { name: 'Принять 1, удалить 1' }).click();
      await expect(page.getByRole('link', { name: 'В банк вопросов' })).toBeVisible();
      await expect(page.getByText('Готов')).toHaveCount(1);
      await logout(page);
    });

    test('teacher gets a grading suggestion and copies it into the form', async ({ page }) => {
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}/a/${ids.assignId}?grade=${ids.studentId}`);
      await page.getByRole('button', { name: 'Принимаю условия' }).click();
      await page
        .getByLabel('Критерии оценивания (необязательно)')
        .fill('Сумма\nРазность\nПроизведение');
      await page.getByRole('button', { name: 'Предложить оценку' }).click();
      await expect(page.getByText(/^Предложение: [\d.]+ из \d+/)).toBeVisible();
      await expect(page.getByText('Разность', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Перенести в форму' }).click();
      await expect(page.locator('#assign-grade')).not.toHaveValue('');
      await expectAccessible(page);
      // nothing is saved until the teacher saves the grade
      const [g] = await sql<{ n: string }>(
        `SELECT count(*) AS n FROM "AssignGrade" WHERE "activityId" = $1 AND "userId" = $2`,
        [ids.assignId, ids.studentId],
      );
      expect(Number(g!.n)).toBe(0);
    });
  });
