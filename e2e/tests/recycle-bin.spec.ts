import { expect, type Page, test } from '@playwright/test';
import { addActivity, newCourse } from './courses';
import { deleteCourse, sql } from './db';
import { ADMIN, expectAccessible, login } from './helpers';

// A deleted activity waits in its course's bin, comes back from it, and is then deleted
// for good; a deleted course waits in the site's bin the same way.

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

const confirm = (page: Page) =>
  page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();

async function deleteActivity(page: Page, courseId: string, name: string) {
  await page.goto(`/course/${courseId}?edit=1`);
  await page.getByRole('button', { name: `Действия: ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Удалить' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
}

test('recycle bins: an activity and a course are restored, then deleted for good', async ({
  page,
}) => {
  test.slow();
  let courseId = '';
  const course = `Корзина ${stamp}`;
  const lecture = `Лекция ${stamp}`;
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, course, `BIN-${stamp}`);
    const activityId = await addActivity(page, courseId, /^Страница/, lecture, async () => {
      await page
        .locator('#f-settings-content .ProseMirror, [id="f-settings-content"]')
        .first()
        .click();
      await page.keyboard.type('Текст лекции');
    });

    // the activity goes to the bin and comes back from it
    await deleteActivity(page, courseId, lecture);
    await page.goto(`/course/${courseId}/bin`);
    await expect(page.getByText(lecture)).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Восстановить' }).click();
    await expect(page.getByText('Корзина пуста')).toBeVisible();
    await page.goto(`/course/${courseId}`);
    await page.getByRole('link', { name: lecture, exact: true }).click();
    await expect(page.getByText('Текст лекции')).toBeVisible();

    // deleted again, then for good
    await deleteActivity(page, courseId, lecture);
    await page.goto(`/course/${courseId}/bin`);
    await page.getByRole('button', { name: 'Удалить навсегда' }).click();
    await confirm(page);
    await expect(page.getByText('Корзина пуста')).toBeVisible();
    await expect
      .poll(async () => (await sql(`SELECT 1 FROM "Activity" WHERE id = $1`, [activityId])).length)
      .toBe(0);

    // the course goes to the site's bin and comes back from it
    await page.goto(`/course/${courseId}/settings`);
    await page.getByRole('button', { name: 'Удалить курс' }).click();
    await confirm(page);
    await page.waitForURL(/\/my-courses/);
    await page.goto(`/admin/courses?q=${encodeURIComponent(stamp)}`);
    // gone from the list of courses
    await expect(page.getByText('Ничего не найдено')).toBeVisible();
    await page.goto(`/admin/courses?bin=1&q=${encodeURIComponent(stamp)}`);
    const row = page.getByRole('row').filter({ hasText: course });
    await expect(row).toBeVisible();
    await expectAccessible(page);
    await row.getByRole('button', { name: 'Восстановить' }).click();
    await expect(row).toHaveCount(0);
    await page.goto(`/course/${courseId}`);
    await expect(page.getByRole('heading', { name: course })).toBeVisible();

    // deleted again, then for good
    await page.goto(`/course/${courseId}/settings`);
    await page.getByRole('button', { name: 'Удалить курс' }).click();
    await confirm(page);
    await page.waitForURL(/\/my-courses/);
    await page.goto(`/admin/courses?bin=1&q=${encodeURIComponent(stamp)}`);
    await row.getByRole('button', { name: 'Удалить навсегда' }).click();
    await confirm(page);
    await expect(row).toHaveCount(0);
    await expect
      .poll(async () => (await sql(`SELECT 1 FROM "Course" WHERE id = $1`, [courseId])).length)
      .toBe(0);
    courseId = '';
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
