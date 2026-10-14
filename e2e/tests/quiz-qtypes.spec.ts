import { expect, type Locator, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// Ordering, select missing words and drag and drop into text, answered on a phone: by
// buttons, lists, a tap on an answer and then on its gap, and the keyboard. The three
// questions go on a third page of the demo quiz for the test and are removed afterwards.

const ORDER = ['Написать', 'Выполнить', 'Проверить'];

/** Moves the items of an ordering question into `want` with its "up" buttons. */
async function arrange(card: Locator, want: string[]) {
  for (let i = 0; i < want.length; i++) {
    const now = await card.locator('ol > li').allInnerTexts();
    const at = now.findIndex((x) => x.includes(want[i]!));
    for (let k = at; k > i; k--)
      await card.getByRole('button', { name: `Выше: ${want[i]}` }).click();
  }
}

test('quiz: ordering and gap questions', async ({ page }) => {
  const [row] = await sql<{
    courseId: string;
    quizId: string;
    userId: string;
    categoryId: string;
    settings: object;
  }>(
    `SELECT c.id AS "courseId", a.id AS "quizId", a.settings, u.id AS "userId",
            (SELECT id FROM "QuestionCategory" WHERE "contextId" = c.id ORDER BY "sortOrder" LIMIT 1) AS "categoryId"
       FROM "Course" c
       JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'quiz'
       JOIN "User" u ON u.username = 'student2'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const { courseId, quizId, userId, categoryId, settings } = row!;
  const quiz = `/course/${courseId}/a/${quizId}`;
  const questions = [
    {
      type: 'ORDERING',
      name: 'E2E порядок',
      text: '<p>Расставьте этапы</p>',
      data: {
        items: ORDER.map((text, i) => ({ id: `i${i}`, text })),
        grading: 'absolutePosition',
        select: 'all',
        selectCount: 6,
        layout: 'vertical',
        numbering: '123',
        showGrading: true,
        feedbackCorrect: '',
        feedbackPartial: '',
        feedbackIncorrect: '',
      },
    },
    {
      type: 'GAPSELECT',
      name: 'E2E пропуски',
      text: '<p>[[2]] неизменяемый, а [[1]] изменяемый.</p>',
      data: {
        shuffle: true,
        choices: [
          { id: 'c1', text: 'list', group: 1 },
          { id: 'c2', text: 'tuple', group: 1 },
        ],
        feedbackCorrect: '',
        feedbackPartial: '',
        feedbackIncorrect: '',
      },
    },
    {
      type: 'DDWTOS',
      name: 'E2E перетаскивание',
      text: '<p>Список — [[1]], словарь — [[3]].</p>',
      data: {
        shuffle: true,
        choices: [
          { id: 'c1', text: 'list', group: 1, infinite: false },
          { id: 'c2', text: 'tuple', group: 1, infinite: false },
          { id: 'c3', text: 'dict', group: 2, infinite: false },
        ],
        feedbackCorrect: '',
        feedbackPartial: '',
        feedbackIncorrect: '',
      },
    },
  ];
  const ids: string[] = [];
  const cleanup = async () => {
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [quizId, settings]);
    await sql(`DELETE FROM "QuizAttempt" WHERE "activityId" = $1 AND "userId" = $2`, [
      quizId,
      userId,
    ]);
    await sql(
      `DELETE FROM "Grade" WHERE "userId" = $1
         AND "gradeItemId" IN (SELECT id FROM "GradeItem" WHERE "activityId" = $2)`,
      [userId, quizId],
    );
    await sql(`DELETE FROM "QuizSlot" WHERE "activityId" = $1 AND slot > 6`, [quizId]);
    await sql(`DELETE FROM "Question" WHERE name LIKE 'E2E %' AND "categoryId" = $1`, [categoryId]);
  };
  await cleanup();
  for (const [k, q] of questions.entries()) {
    const [{ id }] = (await sql<{ id: string }>(
      `INSERT INTO "Question" (id, "categoryId", type, name, text, data, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2::"QuestionType", $3, $4, $5::jsonb, now()) RETURNING id`,
      [categoryId, q.type, q.name, q.text, JSON.stringify(q.data)],
    )) as [{ id: string }];
    ids.push(id);
    await sql(
      `INSERT INTO "QuizSlot" (id, "activityId", page, slot, kind, "questionId", "maxMark")
       VALUES (gen_random_uuid(), $1, 3, $2, 'FIXED', $3, 1)`,
      [quizId, 7 + k, id],
    );
  }
  await sql(
    `UPDATE "Activity" SET settings = settings || '{"behaviour": "interactive"}'::jsonb
      WHERE id = $1`,
    [quizId],
  );
  try {
    // the editor of a drag-and-drop question
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`/course/${courseId}/question-bank/edit?id=${ids[2]}`);
    await expect(page.getByLabel('Вариант 3')).toHaveValue('dict');
    await expect(page.getByText('Без ограничений').first()).toBeVisible();
    await expectAccessible(page);

    // a Cloze question written in the editor: its gaps are read as they are typed
    await page.goto(
      `/course/${courseId}/question-bank/edit?type=MULTIANSWER&category=${categoryId}`,
    );
    await page.getByLabel('Название').fill('E2E cloze');
    await page
      .getByRole('textbox', { name: 'Текст вопроса' })
      .fill('Столица Франции — {1:SA:=Париж}, список — {1:MCH:=list~tuple}');
    await expect(page.getByText('Пропуск 2')).toBeVisible();
    await expect(page.getByText('один вариант')).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForURL(/question-bank\?category=/);
    const [cloze] = await sql<{ id: string }>(
      `SELECT id FROM "Question" WHERE name = 'E2E cloze' AND "categoryId" = $1`,
      [categoryId],
    );
    await sql(
      `INSERT INTO "QuizSlot" (id, "activityId", page, slot, kind, "questionId", "maxMark")
       VALUES (gen_random_uuid(), $1, 3, 10, 'FIXED', $2, 1)`,
      [quizId, cloze!.id],
    );

    await page.context().clearCookies();
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, 'student2', DEMO_PASSWORD);
    await page.goto(quiz);
    await page.getByRole('button', { name: 'Начать попытку' }).click();
    await page.waitForURL(/attempt=/);
    const nav = page.getByRole('navigation', { name: 'Навигация по вопросам' });
    await nav.getByRole('button', { name: 'Вопрос 7' }).click();

    // ordering: never shown in order; put right with the buttons
    const ord = page.locator('#q-7');
    await expect(ord.locator('ol > li')).toHaveCount(3);
    expect(
      (await ord.locator('ol > li').allInnerTexts()).map((x) => x.replace(/^\d+\.\s*/, '')),
    ).not.toEqual(ORDER);
    await arrange(ord, ORDER);
    await ord.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect(ord.getByText('Верно', { exact: true })).toBeVisible();

    // select missing words: a list in each gap
    const gaps = page.locator('#q-8');
    await page.locator('#q8-gap-1').selectOption({ label: 'tuple' });
    await page.locator('#q8-gap-2').selectOption({ label: 'list' });
    await gaps.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect(gaps.getByText('Верно', { exact: true })).toBeVisible();

    // drag and drop into text: tap the answer, then the gap; then by keyboard
    const drag = page.locator('#q-9');
    const bank = drag.getByRole('group', { name: 'Варианты ответа' });
    await bank.getByRole('button', { name: 'list' }).click();
    await page.locator('#q9-gap-1').click();
    await expect(page.locator('#q9-gap-1')).toHaveAccessibleName('Пропуск 1: list');
    await expect(bank.getByRole('button', { name: 'list' })).toBeDisabled();
    await bank.getByRole('button', { name: 'dict' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('#q9-gap-2').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#q9-gap-2')).toHaveAccessibleName('Пропуск 2: dict');
    // the same answers as lists
    await drag.getByRole('button', { name: 'Отвечать списками' }).click();
    await expect(page.locator('#q9-gap-2')).toHaveValue(/.+/);
    await drag.getByRole('button', { name: 'Отвечать перетаскиванием' }).click();
    await expectAccessible(page);
    const sideScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(sideScroll).toBe(false);
    await drag.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect(drag.getByText('Верно', { exact: true })).toBeVisible();

    // Cloze: a field and radio buttons in the text
    const cz = page.locator('#q-10');
    await page.locator('#q10-gap-1').fill('париж');
    await page.locator('#q10-gap-2').getByLabel('list').check();
    await cz.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect(cz.getByText('Верно', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Завершить попытку' }).first().click();
    await page.getByRole('button', { name: 'Завершить попытку' }).last().click();
    await page.waitForURL(/review=/);
    await expect(page.getByText('Баллы по элементам')).toBeVisible();
    await expect(page.getByText('Написать → Выполнить → Проверить')).toBeVisible();
    await expectAccessible(page);
  } finally {
    await cleanup();
  }
});
