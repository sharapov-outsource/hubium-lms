import { writeFile } from 'node:fs/promises';
import { mbzFixture } from '@hubium/interchange/fixtures';
import { expect, test } from '@playwright/test';
import { deleteCourse, sql } from './db';
import { ADMIN, expectAccessible, login } from './helpers';

// The admin backs a course up (the worker writes the archive), downloads it, restores it
// through the import page (the worker does the restore), duplicates the course, and
// round-trips the bank via Moodle XML. A Moodle backup goes in through the same page.

// Courses created here are removed again, so the demo data does not grow with every run.
const created: string[] = [];
test.afterAll(async () => {
  for (const id of created) await deleteCourse(id);
});

test('course backup, restore, duplicate and Moodle XML', async ({ page }, info) => {
  test.slow();
  const [c] = await sql<{ id: string }>(`SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`);
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto(`/course/${c!.id}/settings`);
  await expect(page.getByRole('heading', { name: 'Резервная копия и копирование' })).toBeVisible();
  const before = await page.getByRole('link', { name: /^DEMO-PY-.*\.hubium$/ }).count();
  await page.getByRole('button', { name: 'Создать резервную копию' }).click();
  await expect(page.getByText('Резервная копия готова')).toBeVisible({ timeout: 60_000 });
  // the newest backup comes first in the course's list
  const link = page.getByRole('link', { name: /^DEMO-PY-\d{8}-\d{4}\.hubium$/ }).first();
  await expect(page.getByRole('link', { name: /^DEMO-PY-.*\.hubium$/ })).toHaveCount(
    Math.min(3, before + 1),
  );
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^DEMO-PY-\d{8}-\d{4}\.hubium$/);
  const file = info.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  // it is deleted from the list again
  const name = download.suggestedFilename();
  await page.getByRole('button', { name: `Удалить ${name}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByRole('link', { name })).toHaveCount(0);

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
  created.push(new URL(page.url()).pathname.split('/').at(-1)!);
  await expect(page.getByRole('heading', { name: /Python/ }).first()).toBeVisible();

  // duplicate
  const short = `DUP-${Date.now().toString(36)}`;
  await page.goto(`/course/${c!.id}/settings`);
  await page.locator('#f-shortName').last().fill(short);
  await page.getByRole('button', { name: 'Создать копию' }).click();
  await page.waitForURL(
    (u) => !u.pathname.includes(c!.id) && /\/course\/[0-9a-f-]{36}$/.test(u.pathname),
  );
  const [dup] = await sql<{ id: string; fullName: string }>(
    `SELECT id, "fullName" FROM "Course" WHERE "shortName" = $1`,
    [short],
  );
  created.push(dup!.id);
  expect(dup!.fullName).toMatch(/\(копия\)$/);

  // question bank Moodle XML export
  const xml = await page.request.get(`/course/${c!.id}/question-bank/export?format=xml`);
  expect(xml.status()).toBe(200);
  expect(await xml.text()).toContain('<quiz>');
});

test('a Moodle backup (.mbz) imported through the import page', async ({ page }, info) => {
  test.slow();
  const file = info.outputPath('backup-moodle2-course-2-py.mbz');
  await writeFile(file, await mbzFixture());
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/course/import');
  await page.locator('#import-file').setInputFiles(file);
  await page.getByRole('button', { name: 'Импортировать' }).click();
  await expect(page.getByText(/^Готово: разделов \d+, элементов 17,/)).toBeVisible({
    timeout: 60_000,
  });
  // what the import could not take is listed with the result
  await expect(page.getByRole('listitem').filter({ hasText: '(imscp)' })).toBeVisible();
  await page.getByRole('link', { name: 'Открыть курс' }).click();
  await page.waitForURL(/\/course\/[0-9a-f-]{36}$/);
  created.push(new URL(page.url()).pathname.split('/').at(-1)!);
  await expect(page.getByRole('heading', { name: 'Python из Moodle' })).toBeVisible();
  for (const name of ['Введение', 'Тест', 'Задание'])
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
});
