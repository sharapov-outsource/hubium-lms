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
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('a database: fields, entries with a picture, search and sorting, export and import', async ({
  page,
}) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `База ${stamp}`, `DATA-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const dataId = await addActivity(page, courseId, /^База данных/, 'Библиотека');
    const url = `/course/${courseId}/a/${dataId}`;

    await page.goto(`${url}?tab=fields`);
    const addField = async (type: string, name: string, fill?: () => Promise<void>) => {
      await chooseOption(page.getByLabel('Тип поля'), type);
      await page.getByLabel('Название', { exact: true }).fill(name);
      await fill?.();
      await page.getByRole('button', { name: 'Добавить поле' }).click();
      await expect(page.getByText('Поле сохранено').first()).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible();
    };
    await addField('text', 'Книга', () => page.getByLabel('Обязательное').check());
    await addField('number', 'Год');
    await addField('menu', 'Жанр', () => page.getByLabel('Варианты').fill('Роман\nПовесть'));
    await addField('image', 'Обложка');
    await expectAccessible(page);

    // a learner adds entries
    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    const addEntry = async (book: string, year: string, genre: string, cover = false) => {
      await page.goto(url);
      await page.getByRole('link', { name: 'Добавить запись' }).click();
      await page.getByLabel('Книга *').fill(book);
      await page.getByLabel('Год').fill(year);
      await chooseOption(page.getByLabel('Жанр'), genre);
      if (cover)
        await page
          .getByLabel('Обложка')
          .setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
      await page.getByRole('button', { name: 'Сохранить' }).click();
      await expect(page.getByText('Запись сохранена').first()).toBeVisible();
    };
    await addEntry('Дюна', '1965', 'Роман', true);
    await expect(page.getByText('Дюна')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Обложка' })).toBeVisible();
    await expectAccessible(page);
    await addEntry('Солярис', '1961', 'Повесть');

    await page.goto(url);
    await expect(page.getByText('2 записи')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Поиск по записям' }).fill('сол');
    await page.getByRole('button', { name: 'Найти' }).click();
    await expect(page.getByText('1 запись')).toBeVisible();
    await expect(page.getByRole('article', { name: /^Запись/ })).toHaveCount(1);
    await page.goto(`${url}?sort=Год&order=asc`);
    await expect(page.getByRole('article', { name: /^Запись/ }).first()).toContainText('Солярис');
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, url);
    await page.setViewportSize({ width: 1280, height: 800 });

    // the teacher exports and imports
    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    const csv = await page.request.get(`/api/mod/data/${dataId}/entries.csv`);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toMatch(/Дюна,1965,Роман,cover\.png/);
    await page.goto(`${url}?tab=import`);
    await page.getByLabel('Файл CSV').setInputFiles({
      name: 'books.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Книга,Год,Жанр\nПикник на обочине,1972,Повесть\n'),
    });
    await page.getByRole('button', { name: 'Импортировать' }).click();
    await expect(page.getByText('Добавлена 1 запись')).toBeVisible();
    await page.goto(url);
    await expect(page.getByText('3 записи')).toBeVisible();
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
