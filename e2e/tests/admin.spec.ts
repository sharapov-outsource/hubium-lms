import { expect, test } from '@playwright/test';
import { setSetting, sql } from './db';
import { ADMIN, chooseOption, DEMO_PASSWORD, expectAccessible, login } from './helpers';

const stamp = Date.now();

/** Text in Windows-1251 (Latin and Cyrillic letters only). */
const cp1251 = (s: string) =>
  Buffer.from(
    [...s].map((ch) => {
      const c = ch.codePointAt(0)!;
      return c < 0x80 ? c : c === 0x401 ? 0xa8 : c === 0x451 ? 0xb8 : c - 0x350;
    }),
  );

test('admin creates a user, assigns a site role, the user signs in', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/users');
  await expectAccessible(page);
  await page.getByRole('link', { name: /Новый пользователь|New user/ }).click();
  await page.locator('#f-firstName').fill('Борис');
  await page.locator('#f-lastName').fill('Новиков');
  await page.locator('#f-email').fill(`boris${stamp}@example.com`);
  await page.locator('#f-username').fill(`boris${stamp}`);
  await page.locator('#f-password').fill('Password123');
  await page.getByRole('button', { name: /Создать|Create/ }).click();
  await page.waitForURL(/\/admin\/users\/[0-9a-f-]{36}/);
  await expect(page.getByText(/Пользователь создан|User created/)).toBeVisible();
  await page.getByLabel(/Создатель курсов|Course creator/).check();
  await expect(page.getByText(/Сохранено|Saved/).first()).toBeVisible();

  await page.context().clearCookies();
  await login(page, `boris${stamp}`, 'Password123');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Борис');
});

test('admin logs in as a student and returns', async ({ page }) => {
  const [student] = await sql<{ id: string; name: string }>(
    `SELECT id, name FROM "User" WHERE username = 'student1'`,
  );
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto(`/admin/users/${student!.id}`);
  await page.getByRole('button', { name: 'Войти под пользователем' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Войти под пользователем' }).click();
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByText(`Вы вошли как ${student!.name}`)).toBeVisible();
  await expectAccessible(page);
  // the student's credentials are out of reach
  await page.goto('/settings/account');
  const emailForm = page.locator('form').filter({ has: page.locator('input[name=email]') });
  await emailForm.locator('input[name=email]').fill(`changed${stamp}@example.com`);
  await emailForm.getByRole('button').click();
  await expect(page.getByText('Недоступно, пока вы вошли под другим пользователем')).toBeVisible();

  await page.getByRole('button', { name: 'Вернуться в свою учётную запись' }).click();
  await page.waitForURL(new RegExp(`/admin/users/${student!.id}`));
  await expect(page.getByText(/Вы вошли как/)).toHaveCount(0);
  const [event] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM "EventLog" WHERE name = 'user.loggedinas.stopped' AND "relatedUserId" = $1`,
    [student!.id],
  );
  expect(event!.n).toBeGreaterThan(0);
});

test('a course override takes a permission away from students', async ({ page }) => {
  const [c] = await sql<{ id: string; forum: string; student: string }>(
    `SELECT c.id, (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'forum'
       AND "deletedAt" IS NULL LIMIT 1) AS forum,
       (SELECT id FROM "Role" WHERE "shortName" = 'student') AS student
     FROM "Course" c WHERE c."shortName" = 'DEMO-PY'`,
  );
  const cap = 'mod.forum:startdiscussion';
  // the demo course is shared by every spec: leave it as found
  const reset = () =>
    sql(`DELETE FROM "RoleOverride" WHERE "contextId" = $1 AND capability = $2`, [c!.id, cap]);
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`/course/${c!.id}`);
    await page.getByRole('link', { name: 'Права' }).click();
    await page.waitForURL(/\/permissions/);
    await page.getByRole('link', { name: /^Студент/ }).click();
    await expectAccessible(page);
    await chooseOption(page.getByLabel(cap, { exact: true }), 'DENY');
    await expect(page.getByText(/Сохранено/).first()).toBeVisible();

    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(`/course/${c!.id}/a/${c!.forum}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Новая тема' })).toHaveCount(0);
  } finally {
    await reset();
  }
});

test('custom profile field: defined, filled by an admin, shown on the profile', async ({
  page,
}) => {
  const short = `faculty${stamp}`;
  const [student] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = 'student1'`);
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/profile-fields');
    await expectAccessible(page);
    await page.locator('#f-shortName-new').fill(short);
    await page.locator('#f-name-ru-new').fill('Факультет');
    await chooseOption(page.locator('#f-type-new'), 'menu');
    await page.locator('#f-choices-new').fill('Физфак\nМехмат');
    await page.locator('#f-visibleToOthers-new').check();
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText('Поле сохранено').first()).toBeVisible();

    await page.goto(`/admin/users/${student!.id}`);
    await chooseOption(page.locator(`#f-cf_${short}`), 'Физфак');
    await page.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(page.getByText('Изменения сохранены').first()).toBeVisible();

    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(`/profile/${student!.id}`);
    await expect(page.getByText('Факультет')).toBeVisible();
    await expect(page.getByText('Физфак')).toBeVisible();
  } finally {
    await sql(`DELETE FROM "UserProfileField" WHERE "shortName" = $1`, [short]);
    await sql(`UPDATE "User" SET "customFields" = "customFields" - $1::text`, [short]);
  }
});

test('role matrix change applies and permission checker explains it', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/roles');
  await page.getByRole('link', { name: /^Студент$|^Student$/ }).click();
  const select = page.getByLabel('grade:viewall', { exact: true });
  await chooseOption(select, 'ALLOW');
  await expect(page.getByText(/Сохранено|Saved/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('grade:viewall', { exact: true })).toHaveAttribute(
    'data-value',
    'ALLOW',
  );
  await chooseOption(page.getByLabel('grade:viewall', { exact: true }), 'INHERIT');
  await expect(page.getByText(/Сохранено|Saved/).first()).toBeVisible();

  await page.goto('/admin/permissions?user=manager%40hubium.local&cap=user%3Acreate');
  await expect(page.getByText(/Разрешено|Allowed/).first()).toBeVisible();
  await page.goto('/admin/permissions?user=student1&cap=user%3Acreate');
  await expect(page.getByText(/Запрещено|Denied/).first()).toBeVisible();
});

test('branding: low-contrast colour is adjusted and applied', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/settings/branding');
  await page.locator('#accent').fill('#facc15');
  await expect(page.getByText(/скорректирован|adjusted/)).toBeVisible();
  await page.getByRole('button', { name: /Сохранить|Save/ }).click();
  await page.waitForLoadState('networkidle');
  await page.reload();
  const css = await page.locator('#hubium-brand').innerHTML();
  const light = css.slice(0, css.indexOf('.dark'));
  expect(light).toContain('--accent:#');
  expect(light).not.toContain('--accent:#facc15');
  await setSetting('branding.accent', '#4f46e5');
});

test('manager sees users admin but not site settings', async ({ page }) => {
  await login(page, 'manager', 'Demo12345!');
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const res = await page.goto('/admin/settings/general');
  expect(res?.status()).toBe(403);
});

test('mobile layout shows bottom navigation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await login(page, 'student1', 'Demo12345!');
  const bottom = page.locator('nav.fixed');
  await expect(bottom).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test('bulk actions on selected users: suspend, enrol, export, delete', async ({ page }) => {
  const ids = (
    await sql<{ id: string }>(
      `INSERT INTO "User" (id, email, name, "firstName", "lastName", "emailVerified", "updatedAt")
       VALUES (gen_random_uuid(), 'bulk-a@example.org', 'Анна Массова', 'Анна', 'Массова', true, now()),
              (gen_random_uuid(), 'bulk-b@example.org', 'Борис Массов', 'Борис', 'Массов', true, now())
       RETURNING id`,
    )
  ).map((r) => r.id);
  const [course] = await sql<{ id: string }>(
    `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`,
  );
  // how many of the two match a condition, polled: results land after the toast
  const howMany = (from: string, where: string, params: unknown[] = []) =>
    expect.poll(
      async () =>
        (
          await sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${from} WHERE ${where}`, [
            ids,
            ...params,
          ])
        )[0]!.n,
    );
  const apply = async () => {
    await page.getByRole('button', { name: 'Выполнить' }).click();
    // the selection clears when the action is done
    await expect(page.getByRole('status').filter({ hasText: 'Выбрано' })).toHaveCount(0);
  };
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/users?q=bulk-');
    await page.getByLabel('Выбрать всех на странице').check();
    await expect(page.getByRole('status').filter({ hasText: 'Выбрано: 2' })).toBeVisible();
    await expectAccessible(page);
    await apply();
    await howMany('"User"', `id = ANY($1) AND status = 'SUSPENDED'`).toBe(2);

    await page.getByLabel('Выбрать: Анна Массова').check();
    await page.getByLabel('Выбрать: Борис Массов').check();
    await chooseOption(page.locator('#bulk-action'), 'enrol');
    await chooseOption(page.locator('#bulk-course'), course!.id);
    await chooseOption(page.locator('#bulk-role'), { label: 'Студент' });
    await apply();
    await howMany('"Enrolment"', `"userId" = ANY($1) AND "courseId" = $2`, [course!.id]).toBe(2);

    // the export has the columns of the CSV upload
    await page.getByLabel('Выбрать всех на странице').check();
    const href = await page
      .getByRole('region', { name: 'Действия с выбранными' })
      .getByRole('link', { name: 'CSV' })
      .getAttribute('href');
    const csv = await (await page.request.get(href!)).text();
    expect(csv).toContain('username,email,firstname,lastname');
    expect(csv).toContain('bulk-a@example.org,Анна,Массова');

    // edited in Excel, which saves CSV in Windows-1251 in Russian, it uploads again
    await page.goto('/admin/users/upload');
    await page.getByLabel('Файл CSV, XLSX или ODS').setInputFiles({
      name: 'users.csv',
      mimeType: 'text/csv',
      buffer: cp1251(csv.replace(/^\uFEFF/, '').replace('Массова', 'Массовая')),
    });
    await page.getByRole('button', { name: 'Загрузить' }).click();
    await expect(page.getByText('Создано: 0. Обновлено: 2. Ошибок: 0.')).toBeVisible();
    await howMany('"User"', `id = ANY($1) AND "lastName" = 'Массовая'`).toBe(1);

    await page.goto('/admin/users?q=bulk-');
    await page.getByLabel('Выбрать всех на странице').check();
    await chooseOption(page.locator('#bulk-action'), 'delete');
    await page.getByRole('button', { name: 'Выполнить' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
    await howMany('"User"', `id = ANY($1) AND "deletedAt" IS NOT NULL`).toBe(2);
  } finally {
    await sql(`DELETE FROM "User" WHERE id = ANY($1)`, [ids]);
  }
});

test('groups and cohorts from CSV, checked before import', async ({ page }) => {
  const [course] = await sql<{ id: string }>(
    `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`,
  );
  const upload = async (csv: string) => {
    await page.getByLabel('Файл CSV').setInputFiles({
      name: 'import.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('Будет сделано:')).toBeVisible();
  };
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`/course/${course!.id}/groups`);
    await upload('group;grouping;user\nCSV-Альфа;CSV-Поток;student1\nCSV-Бета;CSV-Поток;nobody');
    await expect(page.getByText('новые: CSV-Альфа')).toBeVisible();
    await expect(
      page.getByText('Строка 3 (CSV-Бета, nobody): Такого пользователя нет'),
    ).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Импортировать' }).click();
    await expect(page.getByText('Импорт выполнен:')).toBeVisible();
    await expect(page.getByText('CSV-Альфа', { exact: true }).first()).toBeVisible();

    await page.goto('/admin/cohorts');
    await upload(
      'name,idnumber,user\nCSV-Когорта,csv-cohort,student1\nCSV-Когорта,csv-cohort,student2',
    );
    await expect(page.getByText('добавлений участников: 2')).toBeVisible();
    await page.getByRole('button', { name: 'Импортировать' }).click();
    await expect(page.getByText('Импорт выполнен:')).toBeVisible();
    const [members] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "CohortMember" m JOIN "Cohort" c ON c.id = m."cohortId"
       WHERE c."idNumber" = 'csv-cohort'`,
    );
    expect(members!.n).toBe(2);
  } finally {
    await sql(`DELETE FROM "Group" WHERE "courseId" = $1 AND name LIKE 'CSV-%'`, [course!.id]);
    await sql(`DELETE FROM "Grouping" WHERE "courseId" = $1 AND name LIKE 'CSV-%'`, [course!.id]);
    await sql(`DELETE FROM "Cohort" WHERE "idNumber" = 'csv-cohort'`);
  }
});

test('groups created automatically from the course students', async ({ page }) => {
  const [course] = await sql<{ id: string }>(
    `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`,
  );
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`/course/${course!.id}/groups`);
    await page.getByLabel('Названия групп').fill('AUTO-#');
    await page.getByLabel('Добавить в группировку').fill('AUTO-Поток');
    await page.getByRole('button', { name: 'Создать группы' }).click();
    await expect(page.getByText('Группы созданы')).toBeVisible();
    await expect(page.getByText('AUTO-1', { exact: true }).first()).toBeVisible();
    const rows = await sql<{ name: string; n: number }>(
      `SELECT g.name, count(m."userId")::int AS n FROM "Group" g
       LEFT JOIN "GroupMember" m ON m."groupId" = g.id
       WHERE g."courseId" = $1 AND g.name LIKE 'AUTO-%' GROUP BY g.name ORDER BY g.name`,
      [course!.id],
    );
    expect(rows.map((r) => r.name)).toEqual(['AUTO-1', 'AUTO-2']);
    expect(Math.abs(rows[0]!.n - rows[1]!.n)).toBeLessThanOrEqual(1);
  } finally {
    await sql(`DELETE FROM "Group" WHERE "courseId" = $1 AND name LIKE 'AUTO-%'`, [course!.id]);
    await sql(`DELETE FROM "Grouping" WHERE "courseId" = $1 AND name LIKE 'AUTO-%'`, [course!.id]);
  }
});
