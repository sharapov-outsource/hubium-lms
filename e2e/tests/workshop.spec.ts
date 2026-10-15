import { expect, type Page, test } from '@playwright/test';
import { addActivity, newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, expectNoSideScroll, login } from './helpers';

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

async function switchPhase(page: Page, url: string, phase: string) {
  await page.goto(url);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: phase, exact: true }).click();
  await expect(page.getByText('Этап изменён').first()).toBeVisible();
}

test('a workshop: the form, work handed in, peers assess, grades calculated and closed', async ({
  page,
}) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Семинар ${stamp}`, `WSHOP-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const wsId = await addActivity(page, courseId, /^Семинар/, 'Рецензии');
    const url = `/course/${courseId}/a/${wsId}`;

    // the assessment form: one criterion of 10 points
    await page.goto(`${url}?tab=form`);
    await page.getByLabel('Описание').fill('Убедительность аргументов');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Сохранить форму' }).click();
    await expect(page.getByText('Форма сохранена').first()).toBeVisible();
    await switchPhase(page, url, 'Представление работ');

    // two learners hand in essays
    for (const [who, title, text] of [
      ['student1', 'Эссе о книгах', 'Книги учат думать.'],
      ['student2', 'Эссе о кино', 'Кино учит видеть.'],
    ] as const) {
      await page.context().clearCookies();
      await login(page, who, DEMO_PASSWORD);
      await selfEnrol(page, courseId);
      await page.goto(url);
      await page.getByRole('link', { name: 'Сдать работу' }).click();
      await page.getByLabel('Название').fill(title);
      await page.locator('#f-content .ProseMirror, [id="f-content"]').first().click();
      await page.keyboard.type(text);
      await page.getByRole('button', { name: 'Сдать работу' }).click();
      await expect(page.getByText('Работа сохранена').first()).toBeVisible();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }
    await expectAccessible(page);

    // the teacher allocates one review per work at random, then opens assessment
    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`${url}?tab=allocation`);
    await page.getByLabel('Число рецензий').fill('1');
    await page.getByRole('button', { name: 'Распределить случайно' }).click();
    await expect(page.getByText('Назначено 2 рецензии').first()).toBeVisible();
    await expectAccessible(page);
    await switchPhase(page, url, 'Оценивание');

    for (const [who, points] of [
      ['student1', '8'],
      ['student2', '6'],
    ] as const) {
      await page.context().clearCookies();
      await login(page, who, DEMO_PASSWORD);
      await page.goto(url);
      await page
        .getByRole('region', { name: 'Работы для оценивания' })
        .getByRole('link')
        .first()
        .click();
      await page.getByLabel('Баллы (от 0 до 10)').fill(points);
      await page.getByLabel('Общий отзыв автору').fill('Хорошая работа');
      if (who === 'student1') await expectAccessible(page);
      await page.getByRole('button', { name: 'Сохранить оценку' }).click();
      await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
      await expect(page.getByText('Оценено')).toBeVisible();
    }

    // grades are calculated, then the workshop closes
    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    await switchPhase(page, url, 'Оценивание оценок');
    await page.getByRole('button', { name: 'Рассчитать оценки' }).click();
    await expect(page.getByText('Оценки рассчитаны').first()).toBeVisible();
    // the book essay got 6 of 10: 48 of 80
    await expect(page.getByRole('row', { name: /Эссе о книгах/ })).toContainText('48');
    await expectAccessible(page);
    await switchPhase(page, url, 'Закрыт');

    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(url);
    await expect(page.getByText('Оценка за работу: 48 из 80')).toBeVisible();
    await expect(page.getByText('Оценка за оценивание: 20 из 20')).toBeVisible();
    await page.getByRole('link', { name: 'Эссе о книгах' }).click();
    await expect(page.getByText('Хорошая работа')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, url);
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
