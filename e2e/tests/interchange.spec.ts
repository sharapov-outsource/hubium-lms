import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, expectAccessible, login } from './helpers';

// The admin downloads a course backup, restores it through the import page (the worker
// does the restore), duplicates the course, and round-trips the bank via Moodle XML.

test('course backup, restore, duplicate and Moodle XML', async ({ page }, info) => {
  test.slow();
  const [c] = await sql<{ id: string }>(`SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`);
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto(`/course/${c!.id}/settings`);
  await expect(page.getByRole('heading', { name: 'Резервная копия и копирование' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Скачать резервную копию' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^DEMO-PY-\d{8}\.hubium$/);
  const file = info.outputPath(download.suggestedFilename());
  await download.saveAs(file);

  await page.goto('/course/import');
  await expect(page.getByRole('heading', { name: 'Импорт курса' })).toBeVisible();
  await expectAccessible(page);
  await page.locator('#import-file').setInputFiles(file);
  await page.getByRole('button', { name: 'Импортировать' }).click();
  await expect(page.getByText(/^Готово: разделов \d+, элементов \d+/)).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('link', { name: 'Открыть курс' }).click();
  await page.waitForURL(/\/course\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /Python/ }).first()).toBeVisible();

  // duplicate
  const short = `DUP-${Date.now().toString(36)}`;
  await page.goto(`/course/${c!.id}/settings`);
  await page.locator('#f-shortName').last().fill(short);
  await page.getByRole('button', { name: 'Создать копию' }).click();
  await page.waitForURL(
    (u) => !u.pathname.includes(c!.id) && /\/course\/[0-9a-f-]{36}$/.test(u.pathname),
  );
  const [dup] = await sql<{ fullName: string }>(
    `SELECT "fullName" FROM "Course" WHERE "shortName" = $1`,
    [short],
  );
  expect(dup!.fullName).toMatch(/\(копия\)$/);

  // question bank Moodle XML export
  const xml = await page.request.get(`/course/${c!.id}/question-bank/export?format=xml`);
  expect(xml.status()).toBe(200);
  expect(await xml.text()).toContain('<quiz>');
});
