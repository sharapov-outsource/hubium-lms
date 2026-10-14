import { expect, test } from '@playwright/test';
import { deleteCourse, sql } from './db';
import { chooseOption, DEMO_PASSWORD, expectAccessible, login, pickDateTime } from './helpers';

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
const shortName = `E2E-${stamp}`;

test.describe
  .serial('teacher builds a course, student completes it', () => {
    let courseUrl = '';

    // Earlier runs leave webinars in the same days; the dashboard lists only the next few.
    test.beforeAll(async () => {
      await sql(`DELETE FROM "CalendarEvent" WHERE title LIKE 'Вебинар %' AND scope = 'COURSE'`);
    });

    // The course (with its enrolments and webinar) and the teacher's site role go again,
    // so every run starts from the seeded data.
    test.afterAll(async () => {
      const [c] = await sql<{ id: string }>(`SELECT id FROM "Course" WHERE "shortName" = $1`, [
        shortName,
      ]);
      if (c) await deleteCourse(c.id);
      await sql(
        `DELETE FROM "RoleAssignment" ra USING "User" u, "Role" r
          WHERE ra."userId" = u.id AND ra."roleId" = r.id AND u.username = 'teacher'
            AND r."shortName" = 'coursecreator'
            AND ra."contextId" = '00000000-0000-7000-8000-000000000001'`,
      );
    });

    test('teacher (course creator) creates a course with a page and self-enrolment key', async ({
      page,
    }) => {
      // teacher needs course:create somewhere: give the coursecreator role at site level
      await sql(
        `INSERT INTO "RoleAssignment"(id, "userId", "roleId", "contextId", component, "createdAt")
       SELECT gen_random_uuid(), u.id, r.id, '00000000-0000-7000-8000-000000000001', 'MANUAL', now()
         FROM "User" u, "Role" r WHERE u.username='teacher' AND r."shortName"='coursecreator'
          AND NOT EXISTS (SELECT 1 FROM "RoleAssignment" x
                           WHERE x."userId" = u.id AND x."roleId" = r.id
                             AND x."contextId" = '00000000-0000-7000-8000-000000000001')`,
      );
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto('/course/new');
      await page.locator('#f-fullName').fill(`E2E курс ${stamp}`);
      await page.locator('#f-shortName').fill(shortName);
      await page.locator('#f-sections').fill('2');
      await page.getByRole('button', { name: /Создать|Create/ }).click();
      await page.waitForURL(/\/course\/[0-9a-f-]{36}\?edit=1/);
      courseUrl = new URL(page.url()).pathname;
      await expectAccessible(page);

      // add a page to section 1
      await page
        .getByRole('button', { name: /Добавить элемент|Add activity/ })
        .nth(1)
        .click();
      await page
        .getByRole('link', { name: /Страница|Page/ })
        .first()
        .click();
      await page.waitForURL(/\/a\/new\?module=page/);
      await page.locator('#f-name').fill('Первый урок');
      await page
        .locator('#f-settings-content .ProseMirror, [id="f-settings-content"]')
        .first()
        .click();
      await page.keyboard.type('Привет, это первый урок.');
      await chooseOption(page.locator('#f-completionMode'), 'MANUAL');
      await page.getByRole('button', { name: /^Создать$|^Create$/ }).click();
      await page.waitForURL(/\?edit=1/);
      await expect(page.getByRole('link', { name: 'Первый урок' })).toBeVisible();

      // self-enrolment with a key
      await page.goto(`${courseUrl}/enrolment`);
      await page.locator('#self-enabled').check();
      await page.locator('#f-key').fill('secret-key');
      await page
        .getByRole('button', { name: /Сохранить|Save/ })
        .first()
        .click();
      await expect(page.getByText(/Сохранено|Saved/).first()).toBeVisible();

      // course event for the calendar
      await page.goto('/calendar');
      await page.locator('#f-title').fill(`Вебинар ${stamp}`);
      const when = new Date(Date.now() + 2 * 86_400_000);
      when.setHours(15, 30, 0, 0);
      await pickDateTime(page, 'f-startsAt', when);
      await chooseOption(page.locator('#f-scope'), 'COURSE');
      await chooseOption(page.locator('#f-courseId'), { label: `E2E курс ${stamp}` });
      await page.getByRole('button', { name: /^Создать$|^Create$/ }).click();
      await expect(page.getByText(`Вебинар ${stamp}`).first()).toBeVisible();

      // the week view puts it in its day, with its time (in the user's time zone)
      const pad = (n: number) => String(n).padStart(2, '0');
      const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
      await page.goto(`/calendar?view=week&w=${day}`);
      const cell = page.getByRole('listitem').filter({ hasText: `Вебинар ${stamp}` });
      await expect(cell).toHaveAccessibleName(new RegExp(`${when.getDate()}`));
      await expect(cell).toContainText(/\d{2}:\d{2}/);
      await expectAccessible(page);
    });

    test('student finds the course, enrols with the key, completes it', async ({ page }) => {
      await login(page, 'student2', DEMO_PASSWORD);
      await page.goto(`/catalog?q=${encodeURIComponent(stamp)}`);
      await page.getByRole('link', { name: new RegExp(`E2E курс ${stamp}`) }).click();
      await page.locator('#f-key').fill('wrong');
      await page.getByRole('button', { name: /Записаться|Enrol/ }).click();
      await expect(page.locator('#f-key')).toHaveAttribute('aria-invalid', 'true');
      await page.locator('#f-key').fill('secret-key');
      await page.getByRole('button', { name: /Записаться|Enrol/ }).click();
      await expect(page.getByRole('link', { name: 'Первый урок' })).toBeVisible();

      await page.getByRole('link', { name: 'Первый урок' }).click();
      await expect(page.getByText('Привет, это первый урок.')).toBeVisible();
      await page.getByRole('button', { name: /Отметить выполненным|Mark as done/ }).click();
      await expect(page.getByRole('button', { name: /Выполнено|Done/ })).toBeVisible();

      await page.goto(courseUrl);
      await expect(page.getByText(/Выполнено 100%|100% complete/)).toBeVisible();
      await page.goto('/dashboard');
      await expect(page.getByText(`Вебинар ${stamp}`)).toBeVisible();
      await expectAccessible(page);
    });

    test('teacher sees completion in the report and the participant list', async ({ page }) => {
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto(`${courseUrl}/completion`);
      await expect(page.getByRole('row', { name: /Мария/ }).getByText('100%')).toBeVisible();
      await page.goto(`${courseUrl}/participants`);
      await expect(page.getByRole('link', { name: 'Мария Сидорова' })).toBeVisible();
      await expectAccessible(page);
    });
  });

test('restricted activity shows its condition and unlocks after completion', async ({ page }) => {
  await sql(
    `DELETE FROM "ActivityCompletion" WHERE "userId"=(SELECT id FROM "User" WHERE username='student3')`,
  );
  await login(page, 'student3', DEMO_PASSWORD);
  const [c] = await sql<{ id: string }>(`SELECT id FROM "Course" WHERE "shortName"='DEMO-PY'`);
  await page.goto(`/course/${c!.id}`);
  await expect(page.getByText(/Доступно, если|Available when/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Условия: if, elif, else' })).toHaveCount(0);
  // opened by its URL, a listed activity still names itself and its conditions
  const [locked] = await sql<{ id: string }>(
    `SELECT id FROM "Activity" WHERE "courseId"=$1 AND name='Условия: if, elif, else'`,
    [c!.id],
  );
  await page.goto(`/course/${c!.id}/a/${locked!.id}`);
  await expect(page.getByRole('heading', { name: 'Условия: if, elif, else' })).toBeVisible();
  await expect(page.getByText(/Доступно, если/)).toBeVisible();
  await page.goto(`/course/${c!.id}`);
  await page.getByRole('link', { name: 'Что такое Python' }).click();
  await page.waitForURL(/\/a\//);
  await expect(page.getByRole('heading', { name: 'Почему Python' })).toBeVisible();
  await page.goto(`/course/${c!.id}`);
  await expect(page.getByRole('link', { name: 'Условия: if, elif, else' })).toBeVisible();
});

test('an activity hidden from students is not found by its URL', async ({ page }) => {
  const [a] = await sql<{ id: string; courseId: string }>(
    `SELECT a.id, a."courseId" FROM "Activity" a JOIN "Course" c ON c.id = a."courseId"
      WHERE c."shortName"='DEMO-PY' AND a.name='Функции и аргументы'`,
  );
  await sql(`UPDATE "Activity" SET visibility='HIDDEN' WHERE id=$1`, [a!.id]);
  try {
    await login(page, 'student3', DEMO_PASSWORD);
    const res = await page.goto(`/course/${a!.courseId}/a/${a!.id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    await expect(page.getByText('Функции и аргументы')).toHaveCount(0);
    await expect(page).not.toHaveTitle(/Функции и аргументы/);
  } finally {
    await sql(`UPDATE "Activity" SET visibility='SHOWN' WHERE id=$1`, [a!.id]);
  }
});

test('view as student hides teacher controls', async ({ page }) => {
  await login(page, 'teacher', DEMO_PASSWORD);
  const [c] = await sql<{ id: string }>(`SELECT id FROM "Course" WHERE "shortName"='DEMO-PY'`);
  await page.goto(`/course/${c!.id}`);
  await page.getByRole('button', { name: /Посмотреть как|View as/ }).click();
  await page.getByRole('menuitem', { name: /Студент|Student/ }).click();
  await expect(page.getByText(/Вы смотрите курс как|You are viewing the course as/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Редактировать|^Edit$/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Вернуться к своей роли|Return to my role/ }).click();
  await expect(page.getByRole('link', { name: /Редактировать|^Edit$/ })).toBeVisible();
});

test('teacher puts groups into a grouping', async ({ page }) => {
  const [c] = await sql<{ id: string }>(`SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`);
  const group = `Группа ${stamp}`;
  const grouping = `Поток ${stamp}`;
  // the demo course is shared by every spec: leave it as found
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`/course/${c!.id}/groups`);
    await page.locator('#f-name').fill(group);
    await page.getByRole('button', { name: 'Создать', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: group })).toBeVisible();
    await page.locator('#f-grouping-name').fill(grouping);
    await page.getByRole('button', { name: 'Создать', exact: true }).last().click();
    const card = page.getByRole('region', { name: grouping });
    await card.getByLabel(group).check();
    await card.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();
    await expectAccessible(page);
    await page.reload();
    await expect(page.getByRole('region', { name: grouping }).getByLabel(group)).toBeChecked();
  } finally {
    await sql(`DELETE FROM "Grouping" WHERE "courseId" = $1 AND name = $2`, [c!.id, grouping]);
    await sql(`DELETE FROM "Group" WHERE "courseId" = $1 AND name = $2`, [c!.id, group]);
  }
});
