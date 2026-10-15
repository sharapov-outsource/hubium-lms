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

test('a glossary: entries, approval, ratings and concepts linked in the course', async ({
  page,
}) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Глоссарий ${stamp}`, `GLOSS-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const glossaryId = await addActivity(page, courseId, /^Глоссарий/, 'Термины', async () => {
      await page.getByLabel('Статьи студентов ждут одобрения').check();
      await page.getByLabel('Связывать понятия в текстах курса с их статьями').check();
      await chooseOption(page.getByLabel('Как считать оценку за рейтинги'), 'average');
      await expectAccessible(page);
    });
    const url = `/course/${courseId}/a/${glossaryId}`;

    // a teacher's entry, linked in the course's texts by its other form too
    await page.goto(url);
    await expect(page.getByText('В глоссарии пока нет статей. Добавьте первую.')).toBeVisible();
    await page.getByRole('link', { name: 'Добавить статью' }).first().click();
    await page.getByLabel('Понятие', { exact: true }).fill('Энтропия');
    await page.locator('#f-definition .ProseMirror, [id="f-definition"]').first().click();
    await page.keyboard.type('Мера беспорядка системы.');
    await page.getByLabel('Другие формы понятия').fill('энтропии');
    await page.getByLabel('Категории', { exact: true }).fill('Физика');
    await expect(page.getByLabel('Связывать это понятие в текстах курса')).toBeChecked();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Статья сохранена').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Энтропия' })).toBeVisible();

    const pageId = await addActivity(page, courseId, /^Страница/, 'Лекция', async () => {
      await page
        .locator('#f-settings-content .ProseMirror, [id="f-settings-content"]')
        .first()
        .click();
      await page.keyboard.type('Рост энтропии в замкнутой системе. Снова энтропии.');
    });

    // a learner reads the page: the concept links to its entry, once
    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await page.goto(`/course/${courseId}/a/${pageId}`);
    const link = page.locator('a[data-autolink]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText('энтропии');
    await expect(link).toHaveAttribute('title', 'Термины: Энтропия');
    await link.click();
    await expect(page.getByRole('heading', { name: 'Энтропия' })).toBeVisible();
    await expect(page.getByText('Мера беспорядка системы.')).toBeVisible();

    await page.goto(`${url}?entry=nope`);
    await expect(
      page.getByText('Этой статьи нет в глоссарии или она вам недоступна.'),
    ).toBeVisible();

    // the learner's entry waits for approval
    await page.goto(url);
    await page.getByRole('link', { name: 'Добавить статью' }).click();
    await page.getByLabel('Понятие', { exact: true }).fill('Ион');
    await page.locator('#f-definition .ProseMirror, [id="f-definition"]').first().click();
    await page.keyboard.type('Заряженная частица.');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText(/другие увидят её, когда преподаватель её одобрит/)).toBeVisible();
    await expect(page.getByText('Ждёт одобрения')).toBeVisible();
    await page.goto(url);
    await expect(page.getByRole('navigation', { name: 'По алфавиту' })).toBeVisible();
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, url);
    await page.setViewportSize({ width: 1280, height: 800 });

    // the teacher approves and rates it
    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(url);
    await page.getByRole('link', { name: 'Ждут одобрения (1)' }).click();
    const entry = page.getByRole('article', { name: 'Ион' });
    await entry.getByRole('button', { name: 'Одобрить' }).click();
    await expect(page.getByText('Статья одобрена').first()).toBeVisible();
    await page.goto(url);
    await chooseOption(
      page.getByRole('article', { name: 'Ион' }).getByLabel(/Ваша оценка статьи/),
      '8',
    );
    await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
    await expect(page.getByRole('article', { name: 'Ион' })).toContainText('Средний рейтинг: 8');
    // search and letters
    await page.getByRole('searchbox', { name: 'Поиск по глоссарию' }).fill('беспорядка');
    await page.getByRole('button', { name: 'Найти' }).click();
    await expect(page.getByText('Найдена 1 статья.')).toBeVisible();
    await page
      .getByRole('navigation', { name: 'По алфавиту' })
      .getByRole('link', { name: 'И' })
      .click();
    // browsing by letter leaves the search
    await expect(page.getByRole('article', { name: 'Энтропия' })).toHaveCount(0);
    await expect(page.getByRole('article', { name: 'Ион' })).toBeVisible();
    await expectAccessible(page);
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
