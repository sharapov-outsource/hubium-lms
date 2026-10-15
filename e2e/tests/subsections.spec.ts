import { expect, test } from '@playwright/test';
import { newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse, sql } from './db';
import {
  ADMIN,
  chooseOption,
  DEMO_PASSWORD,
  expectAccessible,
  expectNoSideScroll,
  login,
} from './helpers';

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

test('subsections: added to a section, hold activities, move and collapse', async ({ page }) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Подразделы ${stamp}`, `SUBS-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const url = `/course/${courseId}`;
    await page.goto(`${url}?edit=1`);
    const section = (name: string) =>
      page
        .locator('[id^="s-"]')
        .filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) });

    // a subsection in section 1, renamed
    await section('Раздел 1').getByRole('button', { name: 'Добавить подраздел' }).click();
    await expect(
      section('Раздел 1').getByRole('region', { name: 'Новый подраздел' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Действия: Новый подраздел' }).click();
    await page.getByRole('menuitem', { name: 'Изменить подраздел' }).click();
    await page.getByLabel('Название подраздела').fill('Практика');
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
    const sub = page.getByRole('region', { name: 'Практика' });
    await expect(sub).toBeVisible();

    // an activity added inside it
    await sub.getByRole('button', { name: 'Добавить элемент' }).click();
    await page
      .getByRole('dialog')
      .getByRole('link', { name: /^Страница/ })
      .click();
    await page.waitForURL(/\/a\/new\?module=page/);
    await page.locator('#f-name').fill('Задача');
    await page
      .locator('#f-settings-content .ProseMirror, [id="f-settings-content"]')
      .first()
      .click();
    await page.keyboard.type('Решите три задачи.');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.waitForURL(/\?edit=1/);
    await expect(sub.getByRole('link', { name: 'Задача' })).toBeVisible();
    await expectAccessible(page);

    // moved with its activity to section 2
    await page.getByRole('button', { name: 'Действия: Практика' }).click();
    await page.getByRole('menuitem', { name: 'Переместить в раздел…' }).click();
    await chooseOption(page.getByRole('dialog').locator('[id^="smv-"]'), { label: 'Раздел 2' });
    await page.getByRole('dialog').getByRole('button', { name: 'Применить' }).click();
    await expect(section('Раздел 2').getByRole('region', { name: 'Практика' })).toBeVisible();
    await expect(section('Раздел 1').getByRole('region', { name: 'Практика' })).toHaveCount(0);

    // a learner sees it in its section and folds it away; the browser remembers
    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await page.goto(url);
    const learner = section('Раздел 2').getByRole('region', { name: 'Практика' });
    await expect(learner.getByRole('link', { name: 'Задача' })).toBeVisible();
    await expectAccessible(page);
    const toggle = learner.getByRole('button', { name: 'Практика' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(learner.getByRole('link', { name: 'Задача' })).toBeHidden();
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(learner.getByRole('link', { name: 'Задача' })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, url);
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});

test('section restrictions: set in its dialog, any of them, kept by a plain edit', async ({
  page,
}) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Условия раздела ${stamp}`, `SACC-${stamp}`);
    await page.goto(`/course/${courseId}?edit=1`);
    const stored = async () =>
      (
        await sql<{ availability: { op: string; c: { type: string }[] } | null }>(
          `SELECT availability FROM "CourseSection" WHERE "courseId" = $1 AND title = $2`,
          [courseId, 'Тема 1'],
        )
      )[0]?.availability;
    const edit = async () => {
      await page.getByRole('button', { name: /^Действия: (Раздел 1|Тема 1)$/ }).click();
      await page.getByRole('menuitem', { name: 'Изменить раздел' }).click();
    };

    // a date and a profile condition, either of them enough
    await edit();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название раздела').fill('Тема 1');
    await dialog.getByRole('button', { name: 'Дата', exact: true }).click();
    await dialog.getByRole('button', { name: 'Профиль', exact: true }).click();
    await chooseOption(dialog.getByLabel('Нужно выполнить'), { label: 'любое из условий' });
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await stored())?.op).toBe('|');
    expect((await stored())?.c.map((c) => c.type)).toEqual(['date', 'profile']);

    // a set within the set (as a backup brings it) is shown and kept by an edit of the title
    await sql(
      `UPDATE "CourseSection" SET availability = jsonb_set(availability, '{c}',
         availability->'c' || '[{"op":"&","c":[{"type":"group"}]}]'::jsonb)
       WHERE "courseId" = $1 AND title = 'Тема 1'`,
      [courseId],
    );
    await page.reload();
    await edit();
    await expect(
      dialog.getByText('Набор условий, все из которых нужно выполнить: 1'),
    ).toBeVisible();
    await dialog.getByLabel('Название раздела').fill('Тема 1');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await stored())?.c.length).toBe(3);
    expect((await stored())?.op).toBe('|');
    await expectAccessible(page);
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
