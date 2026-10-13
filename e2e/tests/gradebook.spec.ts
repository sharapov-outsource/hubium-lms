import { expect, test } from '@playwright/test';
import { sql } from './db';
import { chooseOption, DEMO_PASSWORD, expectAccessible, login } from './helpers';

// The teacher builds a category, a scale and a scale-graded item, grades a student in the
// grader report, then finds the change in the history and downloads the XLSX export.

const stamp = Date.now().toString(36);

test('gradebook: category, scale, history and XLSX export', async ({ page }) => {
  const [c] = await sql<{ id: string }>(`SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`);
  const courseId = c!.id;
  const cat = `Категория ${stamp}`;
  const scale = `Шкала ${stamp}`;
  const item = `Элемент ${stamp}`;
  const base = `/course/${courseId}/grades`;
  // the demo course is shared by every spec: leave it as found
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`${base}?view=setup`);
    await expectAccessible(page);
    await page.locator('#gc-name-new').fill(cat);
    await page.getByRole('button', { name: 'Создать' }).first().click();
    await expect(page.getByRole('region', { name: cat })).toBeVisible();

    await page.goto(`${base}?view=scales`);
    await expectAccessible(page);
    await page.locator('#sc-name-new').fill(scale);
    await page.locator('#sc-items-new').fill('Не зачтено\nЗачтено');
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.locator(`input[value="${scale}"]`)).toBeVisible();

    await page.goto(`${base}?view=setup`);
    await page.locator('#f-name').fill(item);
    await chooseOption(page.locator('#f-categoryId'), { label: `— ${cat}` });
    await chooseOption(page.locator('#f-scaleId'), { label: scale });
    await page.getByRole('button', { name: 'Добавить' }).click();
    await expect(
      page
        .getByRole('region', { name: cat })
        .getByRole('cell', { name: new RegExp(item) })
        .first(),
    ).toBeVisible();

    await page.goto(base);
    const cell = page.getByLabel(new RegExp(`^Иван Петров — ${item}$`));
    await chooseOption(cell, { label: 'Зачтено' });
    await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: new RegExp(`Итог: ${cat}`) }),
    ).toBeVisible();

    await page.goto(`${base}?view=history`);
    await expectAccessible(page);
    const row = page.getByRole('row').filter({ hasText: item });
    await expect(row.first()).toContainText('Зачтено');
    await expect(row.first()).toContainText('Анна Преподавателева');

    const xlsx = await page.request.get(`${base}/export?format=xlsx`);
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()['content-type']).toContain('spreadsheetml');
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe('PK');
  } finally {
    await sql(`DELETE FROM "GradeItem" WHERE "courseId" = $1 AND name = $2`, [courseId, item]);
    await sql(`DELETE FROM "GradeCategory" WHERE "courseId" = $1 AND name = $2`, [courseId, cat]);
    await sql(`DELETE FROM "Scale" WHERE "courseId" = $1 AND name = $2`, [courseId, scale]);
  }
});
