import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// Grades from a sheet in the demo course: the teacher uploads a file, sees the columns
// mapped and what would change (a wrong row flagged), applies it, and exports ODS.

const ITEM = 'E2E импорт';

test('gradebook: importing a sheet in two steps, and exporting ODS', async ({ page }) => {
  const [row] = await sql<{ courseId: string; email: string }>(
    `SELECT c.id AS "courseId", u.email FROM "Course" c, "User" u
      WHERE c."shortName" = 'DEMO-PY' AND u.username = 'student1'`,
  );
  const { courseId, email } = row!;
  const cleanup = () =>
    sql(`DELETE FROM "GradeItem" WHERE "courseId" = $1 AND name = $2`, [courseId, ITEM]);
  await cleanup();
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`/course/${courseId}/grades?view=setup`);
    await page.locator('#f-name').fill(ITEM);
    await page.locator('#f-gradeMax').fill('10');
    await page
      .locator('form')
      .filter({ has: page.locator('#f-idNumber') })
      .getByRole('button', { name: 'Добавить' })
      .click();
    await expect(page.getByRole('row').filter({ hasText: ITEM })).toBeVisible();

    // step one: the file, read and mapped
    await page.locator('#grade-import-file').setInputFiles({
      name: 'grades.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        `email;${ITEM};${ITEM} (отзыв)\n${email};8,5;Отлично\nnobody@example.com;5;\n`,
      ),
    });
    await page.getByRole('button', { name: 'Показать, что будет' }).click();
    await expect(page.getByText('Студентов: 1, оценок: 1, ошибок: 1')).toBeVisible();
    await expect(page.getByText('В курсе нет студента nobody@example.com')).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: `Что в столбце: ${ITEM} (отзыв)` }),
    ).toContainText(`Отзыв: ${ITEM}`);
    await expectAccessible(page);

    // step two: applied
    await page.getByRole('button', { name: 'Загрузить оценки' }).click();
    await expect(page.getByText('Загружено оценок: 1. Ошибок: 1.').first()).toBeVisible();
    const [g] = await sql<{ finalGrade: string; feedback: string }>(
      `SELECT g."finalGrade", g.feedback FROM "Grade" g JOIN "GradeItem" i ON i.id = g."gradeItemId"
        JOIN "User" u ON u.id = g."userId" WHERE i.name = $1 AND u.username = 'student1'`,
      [ITEM],
    );
    expect([Number(g!.finalGrade), g!.feedback]).toEqual([8.5, 'Отлично']);

    // the gradebook as an OpenDocument spreadsheet
    const ods = await page.request.get(`/course/${courseId}/grades/export?format=ods`);
    expect(ods.status()).toBe(200);
    expect(ods.headers()['content-type']).toBe('application/vnd.oasis.opendocument.spreadsheet');
    expect((await ods.body()).subarray(0, 2).toString()).toBe('PK');

    // the item goes through the app, so the course totals follow
    await page.goto(`/course/${courseId}/grades?view=setup`);
    await page
      .getByRole('row')
      .filter({ hasText: ITEM })
      .getByRole('button', { name: 'Удалить' })
      .click();
    await expect(page.getByRole('row').filter({ hasText: ITEM })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
