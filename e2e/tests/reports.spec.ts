import { expect, test } from '@playwright/test';
import { newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse, sql } from './db';
import { ADMIN, chooseOption, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';
import { waitForMail } from './mail';

// A custom report built from the participants source: a condition, a filter the viewer
// sets, a download, an audience who then sees it, and a schedule that emails it.

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

test('reports: built, filtered, downloaded, shared and emailed', async ({ page }) => {
  let courseId = '';
  const name = `Участники ${stamp}`;
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Отчёты ${stamp}`, `REP-${stamp}`);
    await openSelfEnrolment(page, courseId);
    await logout(page);
    await login(page, 'student3', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await logout(page);

    // the report: participants of this course, filtered by name
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/reports');
    await page.locator('#new-report-name').fill(name);
    await chooseOption(page.locator('#new-report-source'), 'participants');
    await page.getByRole('button', { name: 'Создать' }).click();
    await page.waitForURL(/\/reports\/[0-9a-f-]{36}\/edit$/);
    const reportUrl = page.url().replace(/\/edit$/, '');
    await page.getByRole('button', { name: 'Добавить условие' }).click();
    await chooseOption(page.locator('#cond-0'), 'course.shortName');
    await chooseOption(page.locator('#op-0'), 'equals');
    await page.locator('#val-0').fill(`REP-${stamp}`);
    await chooseOption(page.locator('#add-filter'), 'user.fullName');
    await page.getByRole('button', { name: 'Добавить столбец' }).click();
    await chooseOption(page.locator('#col-4'), 'enrolment.roles');
    await page.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();
    await expectAccessible(page);

    await page.goto(reportUrl);
    await expect(page.getByRole('cell', { name: 'Пётр Иванов' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'student' })).toBeVisible();
    await chooseOption(page.getByLabel('Условие').first(), 'contains');
    await page.getByLabel('Значение').fill('пётр');
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page.getByText('1 строка')).toBeVisible();
    await expectAccessible(page);
    const xlsx = await page.request.get(`${reportUrl}/export?format=xlsx`);
    expect(xlsx.headers()['content-type']).toContain('spreadsheetml');
    const csv = await (await page.request.get(`${reportUrl}/export?format=csv`)).text();
    expect(csv).toContain('Пётр Иванов');

    // shared with the learner
    await page.goto(`${reportUrl}/edit`);
    await page.locator('#aud-logins').fill('student3');
    await page.getByRole('button', { name: 'Сохранить' }).nth(1).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();

    // emailed to the manager now
    await page.locator('#sch-name').fill('Каждую неделю');
    await page.locator('#sch-logins').fill('manager');
    await page.getByRole('button', { name: 'Добавить' }).last().click();
    await expect(page.getByText('Каждую неделю')).toBeVisible();
    const before = new Date();
    await page.getByRole('button', { name: 'Отправить сейчас' }).click();
    await expect(page.getByText('Отправлено').first()).toBeVisible();
    const mail = await waitForMail('manager@hubium.local', {
      subject: new RegExp(name),
      after: before,
    });
    expect(mail.Text).toContain(name);
    await logout(page);

    await login(page, 'student3', DEMO_PASSWORD);
    await page.getByRole('link', { name: 'Отчёты' }).first().click();
    await page.getByRole('link', { name }).click();
    await expect(page.getByRole('cell', { name: 'Пётр Иванов' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Изменить' })).toHaveCount(0);
  } finally {
    await sql(`DELETE FROM "CustomReport" WHERE name = $1`, [name]);
    if (courseId) await deleteCourse(courseId);
  }
});
