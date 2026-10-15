import { expect, type Page, test } from '@playwright/test';
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

async function addPage(
  page: Page,
  where: 'first' | string,
  type: string,
  title: string,
  text: string,
  fill?: () => Promise<void>,
) {
  if (where === 'first') {
    await chooseOption(page.getByRole('combobox', { name: 'Тип страницы' }).first(), type);
    await page.getByRole('button', { name: 'Добавить в начало' }).click();
  } else {
    const row = page.getByRole('listitem').filter({ hasText: where });
    await chooseOption(row.getByRole('combobox', { name: 'Тип страницы' }), type);
    await row.getByRole('button', { name: 'Добавить после' }).click();
  }
  await page.getByRole('textbox', { name: 'Заголовок' }).fill(title);
  await page.locator('#f-contents .ProseMirror, [id="f-contents"]').first().click();
  await page.keyboard.type(text);
  await fill?.();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Страница сохранена').first()).toBeVisible();
}

test('a lesson: pages joined by jumps, questions, and the grade from the answers', async ({
  page,
}) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Лекция ${stamp}`, `LESSON-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const lessonId = await addActivity(page, courseId, /^Лекция/, 'Маршрут', async () => {
      await page.getByLabel('Сообщать, верен ли каждый ответ').check();
      await page.getByLabel('Показывать индикатор прохождения').check();
      await expectAccessible(page);
    });
    const url = `/course/${courseId}/a/${lessonId}`;

    await page.goto(`${url}?tab=edit`);
    await expect(page.getByText('В лекции пока нет страниц. Добавьте первую.')).toBeVisible();
    await addPage(page, 'first', 'content', 'Введение', 'Вспомним географию.');
    await addPage(
      page,
      'Введение',
      'truefalse',
      'Столица',
      'Москва — столица России?',
      async () => {
        await page.getByLabel('Отзыв после ответа').first().fill('Правильно!');
        await expectAccessible(page);
      },
    );
    await addPage(
      page,
      'Столица',
      'shortanswer',
      'Река',
      'Самая длинная река Европы?',
      async () => {
        await page.getByLabel('Ответ (* — любой текст)').fill('Волга');
        await chooseOption(page.getByLabel('Затем перейти'), 'end');
      },
    );
    await expect(page.getByRole('listitem').filter({ hasText: 'Река' })).toContainText(
      'Волга → Конец лекции',
    );
    await expectAccessible(page);

    // a learner: a wrong answer leads on (one try), a right one ends the lesson
    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await page.goto(url);
    await page.getByRole('button', { name: 'Начать лекцию' }).click();
    await expect(page.getByRole('heading', { name: 'Введение' })).toBeVisible();
    await expect(page.getByText('Пройдено: 33%')).toBeVisible();
    await page.getByRole('button', { name: 'Дальше' }).click();
    await expect(page.getByRole('heading', { name: 'Столица' })).toBeVisible();
    await page.getByLabel('Неверно').check();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText('Неверно', { exact: true }).last()).toBeVisible();
    await page.getByRole('button', { name: 'Дальше' }).click();
    await expect(page.getByRole('heading', { name: 'Река' })).toBeVisible();
    await page.getByLabel('Ваш ответ').fill('волга');
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText('Верно', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Посмотреть результат' }).click();
    await expect(page.getByRole('heading', { name: 'Вы дошли до конца лекции' })).toBeVisible();
    await expect(page.getByText('Ваш результат: 1 из 2 (50%)')).toBeVisible();
    await expect(page.getByText('Повторно лекцию пройти нельзя.')).toBeVisible();
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, url);
    await page.setViewportSize({ width: 1280, height: 800 });

    // the teacher's report
    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`${url}?tab=reports`);
    await expect(page.getByText('Оценка: 50%')).toBeVisible();
    await expectAccessible(page);
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
