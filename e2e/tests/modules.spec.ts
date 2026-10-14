import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, login } from './helpers';

// Administration → Modules: an administrator turns the forum off; teachers can no longer add
// forums and see the course forum greyed out, learners lose it. The setting is put back.

async function resetModules() {
  await sql(`DELETE FROM "SiteSetting" WHERE key = 'modules.disabled'`);
  await sql(`SELECT pg_notify('hubium_cache', 'settings')`);
}

test('an administrator turns an activity type off and on', async ({ page }) => {
  const [course] = await sql<{ id: string }>(
    `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`,
  );
  const [forum] = await sql<{ id: string }>(
    `SELECT id FROM "Activity" WHERE "courseId" = $1 AND "moduleKey" = 'forum' AND "deletedAt" IS NULL`,
    [course!.id],
  );
  const forumUrl = `/course/${course!.id}/a/${forum!.id}`;
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/modules');
    await expect(
      page.getByRole('heading', { name: 'Модули элементов курса', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Включён: Страница' })).toBeDisabled();
    await expectAccessible(page);
    await page.getByRole('checkbox', { name: 'Включён: Форум' }).uncheck();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();

    await page.context().clearCookies();
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`/course/${course!.id}?edit=1`);
    const row = page.locator(`#a-${forum!.id}`);
    await expect(row.getByText('Отключено')).toBeVisible();
    await expect(row.getByRole('link', { name: 'Форум курса' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Добавить элемент' }).first().click();
    const picker = page.getByRole('dialog');
    await expect(picker.getByRole('link', { name: /^Задание/ })).toBeVisible();
    await expect(picker.getByRole('link', { name: /^Форум/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto(forumUrl);
    await expect(page.getByText('Этот тип элементов отключён администратором')).toBeVisible();

    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(`/course/${course!.id}`);
    await expect(page.getByText('Форум курса')).toHaveCount(0);
    const res = await page.goto(forumUrl);
    expect(res?.status()).toBe(404);

    await resetModules();
    await expect
      .poll(async () => {
        await page.goto(`/course/${course!.id}`);
        return page.getByRole('link', { name: 'Форум курса' }).count();
      })
      .toBe(1);
  } finally {
    await resetModules();
  }
});
