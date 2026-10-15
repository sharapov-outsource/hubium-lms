import { expect, test } from '@playwright/test';
import { addActivity, newCourse } from './courses';
import { deleteCourse } from './db';
import { ADMIN, expectAccessible, expectNoSideScroll, login } from './helpers';

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

test('a teacher writes a book in chapters and subchapters', async ({ page }) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Книга ${stamp}`, `BOOK-${stamp}`);
    const bookId = await addActivity(page, courseId, /^Книга/, 'Учебник');
    await page.goto(`/course/${courseId}/a/${bookId}`);
    await expect(page.getByText('В книге пока нет глав. Добавьте первую.')).toBeVisible();

    const write = async (title: string, text: string) => {
      await page.locator('#bk-title').fill(title);
      await page.locator('#f-content .ProseMirror, [id="f-content"]').first().click();
      await page.keyboard.type(text);
      await page.getByRole('button', { name: 'Сохранить' }).click();
      await expect(page.getByRole('heading', { name: new RegExp(title) })).toBeVisible();
    };
    await page.getByRole('link', { name: 'Добавить главу' }).click();
    await expectAccessible(page);
    await write('Введение', 'Зачем нужен Python.');
    await expect(page.getByRole('heading', { name: '1. Введение' })).toBeVisible();

    const tools = page.getByRole('toolbar', { name: 'Действия с главой' });
    await tools.getByRole('link', { name: 'Добавить подглаву' }).click();
    await write('История', 'Python появился в 1991 году.');
    await expect(page.getByRole('heading', { name: '1.1. История' })).toBeVisible();

    // a chapter added after a subchapter's chapter goes after its subchapters
    await tools.getByRole('link', { name: 'Добавить главу' }).click();
    await write('Синтаксис', 'Отступы важны.');
    await expect(page.getByRole('heading', { name: '2. Синтаксис' })).toBeVisible();
    const toc = page.getByRole('navigation', { name: 'Оглавление' });
    await expect(toc.getByRole('link')).toContainText([
      '1. Введение',
      '1.1. История',
      '2. Синтаксис',
    ]);
    await expectAccessible(page);

    // previous chapter, then hide it
    await page.getByRole('link', { name: /Предыдущая глава/ }).click();
    await expect(page.getByRole('heading', { name: '1.1. История' })).toBeVisible();
    await tools.getByRole('button', { name: 'Скрыть' }).click();
    await expect(tools.getByRole('button', { name: 'Показать' })).toBeVisible();

    // the whole book on one page for printing
    await toc.getByRole('link', { name: 'Печать книги' }).click();
    await expect(page.getByRole('region', { name: '2. Синтаксис' })).toContainText(
      'Отступы важны.',
    );
    await expect(page.getByRole('button', { name: 'Печать' })).toBeVisible();
    await expectAccessible(page);

    // a phone screen: the contents fold away above the chapter
    const chapterUrl = page.url().replace('?print=1', '');
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, chapterUrl);
    await expect(page.locator('summary', { hasText: 'Оглавление' })).toBeVisible();
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
