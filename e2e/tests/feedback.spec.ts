import { expect, test } from '@playwright/test';
import { addActivity, newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse } from './db';
import {
  ADMIN,
  chooseOption,
  DEMO_PASSWORD,
  expectAccessible,
  expectNoSideScroll,
  login,
} from './helpers';

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

test('a teacher builds a survey, a learner answers it page by page', async ({ page }) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Анкета ${stamp}`, `FEEDBACK-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const id = await addActivity(page, courseId, /^Анкета/, 'Отзыв о курсе');
    const url = `/course/${courseId}/a/${id}`;

    await page.goto(`${url}?tab=edit`);
    const add = async (type: string, label: string, extra?: () => Promise<void>) => {
      await chooseOption(page.locator('#fbi-type-new'), type);
      if (label) await page.locator('#fbi-label-new').fill(label);
      await extra?.();
      await page.getByRole('button', { name: 'Добавить', exact: true }).click();
      await expect(page.getByText('Вопрос сохранён').first()).toBeVisible();
      await expect(page.getByText('Вопрос сохранён')).toHaveCount(0, { timeout: 10_000 });
    };
    await add('choice', 'Формат занятий', async () => {
      await page.locator('#fbi-choices-new').fill('Очно\nОнлайн');
      await page.locator('#fbi-required-new').check();
    });
    await add('pagebreak', '');
    await add('number', 'Оценка курса', async () => {
      await page.locator('#fbi-min-new').fill('1');
      await page.locator('#fbi-max-new').fill('5');
    });
    await add('textarea', 'Комментарий');
    await expect(page.getByText('1. Формат занятий')).toBeVisible();
    await expect(page.getByText('3. Комментарий')).toBeVisible();
    await expectAccessible(page);

    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await expectNoSideScroll(page, url);
    await expect(page.getByText('Страница 1 из 2')).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Ответьте на обязательные вопросы').first()).toBeVisible();
    await page.getByLabel('Онлайн').check();
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.getByLabel(/Оценка курса/).fill('4');
    await page.getByLabel(/Комментарий/).fill('Хотелось бы больше практики');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expect(page.getByText('Спасибо, ваши ответы получены.')).toBeVisible();

    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`${url}?tab=analysis`);
    await expect(page.getByText('1 ответ', { exact: true })).toBeVisible();
    await expect(page.getByText('Хотелось бы больше практики')).toBeVisible();
    await expectAccessible(page);
    await page.goto(`${url}?tab=responses`);
    await page.getByText('Ответ 1').click();
    await expect(page.getByText('Онлайн', { exact: true })).toBeVisible();
    const csv = await page.request.get(`/api/mod/feedback/${id}/responses.csv`);
    expect(await csv.text()).toContain('Онлайн');
    await expectAccessible(page);
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
