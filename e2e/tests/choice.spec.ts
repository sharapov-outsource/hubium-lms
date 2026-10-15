import { expect, test } from '@playwright/test';
import { addActivity, newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, expectNoSideScroll, login } from './helpers';

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

test('learners answer a choice with limited places; the teacher sees who chose what', async ({
  page,
}) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Опрос ${stamp}`, `CHOICE-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const choiceId = await addActivity(page, courseId, /^Опрос/, 'Тема проекта', async () => {
      await page.getByLabel('Вариант 1', { exact: true }).fill('Чат-бот');
      await page.getByLabel('Вариант 2', { exact: true }).fill('Игра');
      await page.getByRole('button', { name: 'Добавить вариант' }).click();
      await page.getByLabel('Вариант 3', { exact: true }).fill('Сайт');
      await page.getByLabel('Ограничить число ответов на вариант').check();
      await page.getByLabel('Лимит варианта 1').fill('1');
      await expectAccessible(page);
    });
    const url = `/course/${courseId}/a/${choiceId}`;

    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await page.goto(url);
    await expect(page.getByText('Результаты появятся после вашего ответа.')).toBeVisible();
    await page.getByLabel(/Чат-бот/).check();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText('Ответ сохранён').first()).toBeVisible();
    await expect(page.getByText(/Ваш ответ: ?Чат-бот/)).toBeVisible();
    await expect(page.getByText('Ответил 1 человек')).toBeVisible();
    await expectAccessible(page);
    await expectNoSideScroll(page, url);

    // the only place is taken for everyone else
    await page.context().clearCookies();
    await login(page, 'student2', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await page.goto(url);
    await expect(page.getByLabel(/Чат-бот/)).toBeDisabled();
    await expect(page.getByText('Мест нет')).toBeVisible();
    await page.getByLabel(/Игра/).check();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText('Ответ сохранён').first()).toBeVisible();

    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(url);
    await expect(page.getByText('Ответили 2 человека')).toBeVisible();
    const csv = await page.request.get(`/api/mod/choice/${choiceId}/responses.csv`);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toMatch(/student1.*Чат-бот/);
    await expectAccessible(page);
    await page.getByRole('checkbox', { name: /Чат-бот/ }).check();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /Удалить ответы \(1\)/ }).click();
    await expect(page.getByText('Ответы удалены').first()).toBeVisible();
    await expect(page.getByText('Ответил 1 человек')).toBeVisible();
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
