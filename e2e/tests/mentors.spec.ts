import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, chooseOption, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// Mentors and parents: the administrator turns the feature on and links people; a parent
// follows their child's courses, progress and grades, and loses access once it is off again.
// The demo data has `parent` linked to student1.

const users = async () => {
  const rows = await sql<{ username: string; id: string }>(
    `SELECT username, id FROM "User" WHERE username IN ('parent', 'student1', 'student2')`,
  );
  return Object.fromEntries(rows.map((r) => [r.username, r.id])) as Record<string, string>;
};

const setMentors = async (page: import('@playwright/test').Page, on: boolean) => {
  await page.goto('/admin/settings/general');
  const toggle = page.getByLabel('Наставники и родители');
  if (on) await toggle.check();
  else await toggle.uncheck();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено').first()).toBeVisible();
};

test.describe
  .serial('mentors and parents', () => {
    test.afterAll(async () => {
      const u = await users();
      await sql(`DELETE FROM "UserRelation" WHERE "mentorId" = $1 AND "menteeId" = $2`, [
        u.parent,
        u.student2,
      ]);
      await sql(`DELETE FROM "SiteSetting" WHERE key = 'mentors.enabled'`);
      await sql(`SELECT pg_notify('hubium_cache', 'settings')`);
    });

    test('nothing shows while the feature is off', async ({ page }) => {
      await sql(`DELETE FROM "SiteSetting" WHERE key = 'mentors.enabled'`);
      await sql(`SELECT pg_notify('hubium_cache', 'settings')`);
      const u = await users();
      await login(page, 'parent', DEMO_PASSWORD);
      await expect(page.getByRole('link', { name: 'Мои подопечные' })).toHaveCount(0);
      expect((await page.goto(`/mentees/${u.student1}`))?.status()).toBe(403);
    });

    test('the administrator turns mentors on and links a mentor', async ({ page }) => {
      const u = await users();
      await login(page, ADMIN.login, ADMIN.password);
      await page.goto(`/admin/users/${u.student2}`);
      await expect(page.getByText('Выключено в настройках сайта')).toBeVisible();
      await setMentors(page, true);

      await page.goto(`/admin/users/${u.student2}`);
      await expect(page.getByText('Выключено в настройках сайта')).toHaveCount(0);
      await expect(page.getByText('Наставников и родителей нет.')).toBeVisible();
      await chooseOption(page.getByLabel('Кто', { exact: true }), 'MENTOR');
      await page.getByLabel('Добавить наставника или родителя').fill('parent@');
      await page.getByRole('button', { name: /Ольга Петрова/ }).click();
      await expect(page.getByRole('button', { name: 'Убрать Ольга Петрова' })).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: 'Ольга Петрова' })).toContainText(
        'Наставник',
      );
      await expectAccessible(page);

      // the parent's own card lists both of the people they follow
      await page.goto(`/admin/users/${u.parent}`);
      await expect(page.getByRole('link', { name: 'Иван Петров' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Мария Сидорова' })).toBeVisible();

      const sent = await sql(
        `SELECT 1 FROM "EventLog" WHERE name = 'user.relation.added' AND "relatedUserId" = $1`,
        [u.student2],
      );
      expect(sent.length).toBeGreaterThan(0);
    });

    test('the administrator links and unlinks from a CSV file', async ({ page }) => {
      await login(page, ADMIN.login, ADMIN.password);
      await page.goto(`/admin/users/${(await users()).student2}`);
      await page.getByRole('link', { name: 'Связать из CSV-файла' }).click();
      await expect(
        page.getByRole('heading', { name: 'Связать наставников и родителей' }),
      ).toBeVisible();
      await expectAccessible(page);
      const csv = [
        'mentor,mentee,kind,action',
        'parent,student3,mentor,add',
        'parent@hubium.local,student3,,remove',
        'nobody,student1,,',
      ].join('\n');
      await page.getByLabel('CSV-файл').setInputFiles({
        name: 'mentors.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csv),
      });
      await page.getByRole('button', { name: 'Загрузить' }).click();
      await expect(page.getByText('Связано: 1, отвязано: 1, ошибок: 1')).toBeVisible();
      await expect(page.getByText('Строка 4: Unknown mentor "nobody"')).toBeVisible();
    });

    test("a parent follows their child's courses and grades", async ({ page }) => {
      const u = await users();
      await login(page, 'parent', DEMO_PASSWORD);
      await page.getByRole('link', { name: 'Мои подопечные' }).first().click();
      await expect(page).toHaveURL(/\/mentees$/);
      await expect(page.getByRole('heading', { name: 'Мои подопечные', level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Мария Сидорова' })).toBeVisible();
      await expectAccessible(page);

      await page.getByRole('link', { name: 'Иван Петров' }).click();
      await expect(page.getByRole('heading', { name: 'Иван Петров', level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Курсы' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Ближайшие сроки' })).toBeVisible();
      await expectAccessible(page);

      const course = page.locator('main table a').first();
      const name = (await course.textContent())!.trim();
      await course.click();
      await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
      await expect(page.getByRole('table')).toBeVisible();
      await expectAccessible(page);

      // nothing for other learners, and nothing to change
      expect((await page.goto(`/admin/users/${u.student1}`))?.status()).toBe(403);
      const [other] = await sql<{ id: string }>(
        `SELECT id FROM "User" WHERE username = 'student3'`,
      );
      expect((await page.goto(`/mentees/${other!.id}`))?.status()).toBe(403);
    });

    test('the learner sees who follows their learning', async ({ page }) => {
      await login(page, 'student1', DEMO_PASSWORD);
      await page.goto('/settings/privacy');
      await expect(page.getByRole('heading', { name: 'Кто следит за вашей учёбой' })).toBeVisible();
      await expect(page.getByText('Ольга Петрова')).toBeVisible();
      await expectAccessible(page);
    });

    test('turning mentors off takes the access away', async ({ page }) => {
      const u = await users();
      await login(page, ADMIN.login, ADMIN.password);
      await setMentors(page, false);
      await logout(page);
      await login(page, 'parent', DEMO_PASSWORD);
      await expect(page.getByRole('link', { name: 'Мои подопечные' })).toHaveCount(0);
      expect((await page.goto(`/mentees/${u.student1}`))?.status()).toBe(403);
    });
  });
