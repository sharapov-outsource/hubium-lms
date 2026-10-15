import { expect, test } from '@playwright/test';
import { newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse, sql } from './db';
import { ADMIN, chooseOption, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// A competency framework built by hand, linked to a course and rated there by a teacher
// (its parent following by rule), gathered into a learning plan from a template, and a
// learner's own plan sent for review and approved.

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
const FW = `DATA-${stamp}`;

test('competencies: a framework, ratings in a course, learning plans and a review', async ({
  page,
}) => {
  let courseId = '';
  const [student] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = 'student3'`);
  try {
    // the framework: a parent completed when both its children are
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/competencies');
    await page.getByRole('link', { name: 'Новый фреймворк' }).click();
    await page.locator('#fw-name').fill(`Работа с данными ${stamp}`);
    await page.locator('#fw-idnumber').fill(FW);
    await chooseOption(page.getByLabel('Шкала'), 'new');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForURL(/\/admin\/competencies\/[0-9a-f-]{36}$/);
    const frameworkUrl = page.url();
    await page.locator('#top-name').fill('Анализ данных');
    await page.locator('#top-idnumber').fill(`${FW}.0`);
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await page.getByRole('link', { name: /Анализ данных/ }).click();
    for (const [name, n] of [
      ['Таблицы', 1],
      ['Графики', 2],
    ] as const) {
      await page.locator('#child-name').fill(name);
      await page.locator('#child-idnumber').fill(`${FW}.${n}`);
      await page
        .locator('form')
        .filter({ has: page.locator('#child-name') })
        .getByRole('button', { name: 'Добавить' })
        .click();
      await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
    }
    await chooseOption(page.locator('#rule-type'), 'ALL');
    await chooseOption(page.locator('#rule-outcome'), 'COMPLETE');
    await page.getByRole('button', { name: 'Сохранить' }).nth(1).click();
    await expect(page.getByText('Освоены все вложенные').first()).toBeVisible();
    await expectAccessible(page);
    const csv = await (await page.request.get(`${frameworkUrl.split('?')[0]}/export`)).text();
    expect(csv).toContain(`${FW}.2`);
    expect(csv).toContain('competency_rule_all');

    // the course: both children linked, the learner rated on them
    courseId = await newCourse(page, `Компетенции ${stamp}`, `COMP-${stamp}`);
    await openSelfEnrolment(page, courseId);
    await logout(page);
    await login(page, 'student3', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await logout(page);
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`/course/${courseId}/competencies`);
    await chooseOption(page.getByLabel('Фреймворк'), { label: `Работа с данными ${stamp}` });
    const picker = page.getByRole('group', { name: 'Выберите компетенции' });
    await picker.getByLabel(/Таблицы/).check();
    await picker.getByLabel(/Графики/).check();
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Таблицы' })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('link', { name: 'Сводка по компетенциям' }).click();
    await page.getByRole('link', { name: 'Пётр Иванов' }).click();
    const rateSelects = page.locator('[id^="rate-"][role="combobox"]');
    await expect(rateSelects).toHaveCount(2);
    for (const i of [0, 1]) {
      await chooseOption(rateSelects.nth(i), { label: 'Освоено' });
      await page.getByRole('button', { name: 'Оценить' }).nth(i).click();
      await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
    }
    await expect(page.getByText('Оценка в курсе').first()).toBeVisible();

    // a learning plan from a template, for the learner
    await page.goto('/admin/competencies/templates');
    await page.locator('#tpl-name').fill(`Аналитик ${stamp}`);
    await page.getByRole('button', { name: 'Создать' }).click();
    await page.getByRole('link', { name: `Аналитик ${stamp}` }).click();
    await chooseOption(page.getByLabel('Фреймворк'), { label: `Работа с данными ${stamp}` });
    await page.getByLabel('Поиск').fill(FW);
    const tplPicker = page.getByRole('group', { name: 'Выберите компетенции' });
    for (const name of [/Анализ данных/, /Таблицы/, /Графики/])
      await tplPicker.getByLabel(name).check();
    await page.getByRole('button', { name: 'Добавить компетенции' }).click();
    await expect(page.getByText(`${FW}.0`).first()).toBeVisible();
    await page.locator('#plan-logins').fill('student3');
    await page.getByRole('button', { name: 'Создать', exact: true }).last().click();
    await expect(page.getByText('Планы созданы').first()).toBeVisible();
    await expectAccessible(page);
    await logout(page);

    // the learner: the plan, all three proficient (the parent by its rule)
    await login(page, 'student3', DEMO_PASSWORD);
    await page.goto('/plans');
    await expect(page.getByText('Освоено 3 из 3')).toBeVisible();
    await page.getByRole('link', { name: `Аналитик ${stamp}` }).click();
    await expect(page.getByRole('cell', { name: /Анализ данных/ })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('link', { name: 'Анализ данных' }).click();
    await expect(page.getByText(/Выполнено правило/)).toBeVisible();

    // their own plan, sent for review
    await page.goto('/plans');
    await page.locator('#plan-name').fill(`Свой план ${stamp}`);
    await page.getByRole('button', { name: 'Создать' }).click();
    await page.getByRole('link', { name: `Свой план ${stamp}` }).click();
    await chooseOption(page.getByLabel('Фреймворк'), { label: `Работа с данными ${stamp}` });
    await page
      .getByRole('group', { name: 'Выберите компетенции' })
      .getByLabel(/Графики/)
      .check();
    await page.getByRole('button', { name: 'Добавить компетенции' }).click();
    await expect(page.getByRole('link', { name: 'Графики' })).toBeVisible();
    await page.getByRole('button', { name: 'Отправить на проверку' }).click();
    await expect(page.getByText('Ждёт проверки').first()).toBeVisible();
    await logout(page);

    // a reviewer approves it
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/competencies/reviews');
    await page.getByRole('link', { name: new RegExp(`Свой план ${stamp}`) }).click();
    await page.getByRole('button', { name: 'Начать проверку' }).click();
    await expect(page.getByText('На проверке').first()).toBeVisible();
    await page.getByRole('button', { name: 'Утвердить' }).click();
    await expect(page.getByText('Действует').first()).toBeVisible();
  } finally {
    await sql(`DELETE FROM "LearningPlan" WHERE "userId" = $1 AND name LIKE $2`, [
      student!.id,
      `%${stamp}`,
    ]);
    await sql(`DELETE FROM "LearningPlanTemplate" WHERE name LIKE $1`, [`%${stamp}`]);
    if (courseId) await deleteCourse(courseId);
    await sql(`DELETE FROM "CompetencyFramework" WHERE "idNumber" = $1`, [FW]);
  }
});
