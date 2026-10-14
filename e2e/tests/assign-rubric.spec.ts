import { expect, type Page, test } from '@playwright/test';
import { sql } from './db';
import { chooseOption, DEMO_PASSWORD, expectAccessible, login } from './helpers';

// Marking the demo assignment: the teacher defines a rubric, grades a submission with it
// and releases the grade, which the student then sees with the rubric on a phone; and
// blind marking, where the teacher sees a participant number until revealing who is who.

async function demo() {
  const [row] = await sql<{
    courseId: string;
    assignId: string;
    settings: object;
    s1: string;
    name: string;
  }>(
    `SELECT c.id AS "courseId", a.id AS "assignId", a.settings,
            u.id AS s1, u.name
       FROM "Course" c
       JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'assign'
       JOIN "User" u ON u.username = 'student1'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const { courseId, assignId, settings, s1, name } = row!;
  const cleanup = async () => {
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [assignId, settings]);
    for (const table of [
      'GradingDefinition',
      'AssignUserFlags',
      'AssignParticipant',
      'AssignState',
    ])
      await sql(`DELETE FROM "${table}" WHERE "activityId" = $1`, [assignId]);
    await sql(`DELETE FROM "AssignSubmission" WHERE "activityId" = $1 AND "userId" = $2`, [
      assignId,
      s1,
    ]);
    await sql(`DELETE FROM "AssignGrade" WHERE "activityId" = $1 AND "userId" = $2`, [
      assignId,
      s1,
    ]);
    await sql(
      `DELETE FROM "Grade" WHERE "userId" = $1
         AND "gradeItemId" IN (SELECT id FROM "GradeItem" WHERE "activityId" = $2)`,
      [s1, assignId],
    );
  };
  const use = (extra: object) =>
    sql(`UPDATE "Activity" SET settings = settings || $2::jsonb WHERE id = $1`, [
      assignId,
      JSON.stringify(extra),
    ]);
  return { url: `/course/${courseId}/a/${assignId}`, assignId, s1, name, cleanup, use };
}

async function submit(page: Page, url: string, text: string) {
  await login(page, 'student1', DEMO_PASSWORD);
  await page.goto(url);
  await page.locator('#assign-text').click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Отправить на проверку' }).first().click();
  await page.getByRole('button', { name: 'Отправить на проверку' }).last().click();
  await expect(page.getByText('Отправлено на проверку').first()).toBeVisible();
  await page.context().clearCookies();
}

test('assignment: a rubric, the marking workflow and the released grade', async ({ page }) => {
  const d = await demo();
  await d.cleanup();
  await d.use({ gradingMethod: 'rubric', markingWorkflow: true });
  try {
    // the teacher defines the rubric: two criteria of three levels (0, 1, 2 points)
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`${d.url}?tab=grading`);
    const criteria = page.getByLabel('Описание критерия');
    const levels = page.getByLabel('Описание уровня');
    await criteria.first().fill('Структура');
    for (const [i, text] of ['Нет', 'Частично', 'Ясная'].entries()) await levels.nth(i).fill(text);
    await page.getByRole('button', { name: 'Добавить критерий' }).click();
    await criteria.nth(1).fill('Аргументы');
    for (const [i, text] of ['Нет', 'Есть', 'Убедительные'].entries())
      await levels.nth(3 + i).fill(text);
    await page.getByRole('button', { name: 'Сохранить форму' }).click();
    await expect(page.getByText('Форма сохранена').first()).toBeVisible();
    await expectAccessible(page);
    await page.context().clearCookies();

    await submit(page, d.url, 'Моё эссе о Python');

    // graded with the rubric: 3 of 4 points, released at once
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(d.url);
    await page
      .getByRole('row')
      .filter({ hasText: d.name })
      .getByRole('link', { name: 'Оценить' })
      .click();
    await page.getByRole('radio', { name: /Ясная/ }).check();
    await page.getByRole('radio', { name: /Есть/ }).check();
    await page.getByLabel('Комментарий').nth(1).fill('Мало примеров');
    await expect(page.getByText('Оценка по форме: 7.5 из 10')).toBeVisible();
    await chooseOption(page.locator('#assign-workflow'), { label: 'Выпущено' });
    await page.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
    await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
    await expectAccessible(page);
    await page.goto(d.url);
    const row = page.getByRole('row').filter({ hasText: d.name });
    await expect(row).toContainText('Выпущено');
    await expect(row).toContainText('7.5 / 10');
    await expectAccessible(page);
    await page.context().clearCookies();

    // the student sees the grade with the rubric as filled, on a phone
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(d.url);
    await expect(page.getByText('Оценка: 7.5 из 10')).toBeVisible();
    await expect(page.getByText('Мало примеров')).toBeVisible();
    await expect(page.getByText(/Ясная/)).toBeVisible();
    await expectAccessible(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    ).toBe(false);
  } finally {
    await d.cleanup();
  }
});

test('assignment: blind marking shows participant numbers until revealed', async ({ page }) => {
  const d = await demo();
  await d.cleanup();
  await d.use({ blindMarking: true });
  try {
    await submit(page, d.url, 'Анонимная работа');
    const [p] = await sql<{ number: number }>(
      `SELECT number FROM "AssignParticipant" WHERE "activityId" = $1 AND "userId" = $2`,
      [d.assignId, d.s1],
    );
    const label = `Участник ${p!.number}`;
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(d.url);
    const table = page.getByRole('table');
    await expect(table).toContainText(label);
    await expect(table).not.toContainText(d.name);
    await expectAccessible(page);
    await page
      .getByRole('row')
      .filter({ hasText: label })
      .getByRole('link', { name: 'Оценить' })
      .click();
    await expect(page.getByRole('heading', { name: `Проверка: ${label}` })).toBeVisible();
    await expect(page.getByText(d.name)).toHaveCount(0);
    await page.locator('#assign-grade').fill('9');
    await page.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
    await expect(page.getByText('Оценка сохранена').first()).toBeVisible();

    // revealing, once confirmed, shows the names and releases the grade
    await page.goto(d.url);
    await page.getByRole('button', { name: 'Раскрыть имена студентов' }).click();
    await page.getByRole('button', { name: 'Раскрыть имена студентов' }).click();
    await expect(page.getByText('Имена раскрыты').first()).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: d.name })).toContainText('9 / 10');
  } finally {
    await d.cleanup();
  }
});
