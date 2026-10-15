import { expect, test } from '@playwright/test';
import { addActivity, newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, expectNoSideScroll, login } from './helpers';

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

test('a wiki: pages linked by title, versions compared, and a page locked while edited', async ({
  page,
  browser,
}) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Вики ${stamp}`, `WIKI-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const wikiId = await addActivity(page, courseId, /^Вики/, 'Вики курса', async () => {
      await expect(page.getByLabel('Первая страница')).toHaveValue('Главная');
      await expectAccessible(page);
    });
    const url = `/course/${courseId}/a/${wikiId}`;

    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await page.goto(url);
    await expect(page.getByText('Страница «Главная» ещё не написана.')).toBeVisible();
    const write = async (text: string) => {
      await page.locator('#f-content .ProseMirror, [id="f-content"]').first().click();
      await page.keyboard.press('End');
      await page.keyboard.type(text);
      await page.getByRole('button', { name: 'Сохранить' }).click();
      await expect(page.getByText('Страница сохранена').first()).toBeVisible();
    };
    await page.getByRole('link', { name: 'Написать страницу' }).click();
    await write('Темы курса: [[Циклы]].');
    // a link to a page not written yet leads to writing it
    const link = page.getByRole('link', { name: 'Циклы' });
    await expect(link).toHaveAttribute('data-new', '');
    await link.click();
    await expect(page.getByText('Страница «Циклы» ещё не написана.')).toBeVisible();
    await page.getByRole('link', { name: 'Написать страницу' }).click();
    await write('Циклы for и while.');
    await expect(page.getByRole('heading', { name: 'Циклы' })).toBeVisible();
    await page.getByRole('link', { name: 'Правка' }).click();
    await write(' И do.');
    await expectAccessible(page);

    // the history compares versions
    await page.getByRole('link', { name: 'История' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(2);
    await page.getByRole('link', { name: 'Сравнить с предыдущей' }).click();
    await expect(page.locator('ins')).toContainText('do');
    await expectAccessible(page);

    // while student1 edits, student2 sees the page locked
    const pageId = new URL(page.url()).searchParams.get('page');
    const editUrl = `${url}?page=${pageId}&edit=1`;
    await page.goto(editUrl);
    await expect(page.locator('#f-content')).toBeVisible();
    const other = await browser.newContext();
    const page2 = await other.newPage();
    try {
      await login(page2, 'student2', DEMO_PASSWORD);
      await selfEnrol(page2, courseId);
      await page2.goto(editUrl);
      await expect(page2.getByText(/Эту страницу правит/)).toBeVisible();
      await expect(page2.getByRole('button', { name: 'Перехватить правку' })).toHaveCount(0);
    } finally {
      await other.close();
    }
    await page.getByRole('link', { name: 'Отмена' }).click();

    await page.getByRole('link', { name: 'Все страницы' }).click();
    await expect(page.getByRole('link', { name: 'Главная' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Циклы' })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, url);
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
