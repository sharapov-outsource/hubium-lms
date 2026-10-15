import { expect, type Page, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// A calculated grade item in the demo course: the teacher gives items ID numbers, writes a
// formula with a reference picked from the list (a wrong one is flagged while typing), and
// cannot delete what the formula uses until the formula goes.

const NAMES = ['E2E ДЗ', 'E2E итог'];

test('gradebook: a formula over another item', async ({ page }) => {
  const [course] = await sql<{ id: string }>(
    `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`,
  );
  const cleanup = () =>
    sql(`DELETE FROM "GradeItem" WHERE "courseId" = $1 AND name = ANY($2)`, [course!.id, NAMES]);
  await cleanup();
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`/course/${course!.id}/grades?view=setup`);
    const add = async (name: string, max: string, idNumber: string) => {
      await page.locator('#f-name').fill(name);
      await page.locator('#f-gradeMax').fill(max);
      await page.locator('#f-idNumber').fill(idNumber);
      await page
        .locator('form')
        .filter({ has: page.locator('#f-idNumber') })
        .getByRole('button', { name: 'Добавить' })
        .click();
      await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
    };
    await add(NAMES[0]!, '10', 'e2ehw');
    await add(NAMES[1]!, '100', 'e2efinal');

    const row = (name: string) => page.getByRole('row').filter({ hasText: name });
    await row(NAMES[1]!)
      .getByRole('button', { name: `Формула: ${NAMES[1]}` })
      .click();
    const dialog = page.getByRole('dialog');
    const formula = dialog.getByLabel('Формула', { exact: true });
    await formula.fill('=[[nope]] * 10');
    await expect(dialog.getByText('Нет элемента или категории с ID-номером «nope»')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Сохранить формулу' })).toBeDisabled();
    await formula.fill('=');
    await dialog.getByRole('button', { name: 'Вставить [[e2ehw]]' }).click();
    await formula.press('End');
    await page.keyboard.type(' * 10');
    await expect(formula).toHaveValue('=[[e2ehw]] * 10');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Сохранить формулу' }).click();
    await expect(page.getByText('Формула сохранена').first()).toBeVisible();
    await expect(row(NAMES[1]!)).toContainText('=[[e2ehw]] * 10');
    await expectAccessible(page);

    // what the formula uses stays until the formula goes
    await deleteItem(page, NAMES[0]!);
    await expect(page.getByText(/Формулы используют этот элемент/).first()).toBeVisible();
    await row(NAMES[1]!)
      .getByRole('button', { name: `Формула: ${NAMES[1]}` })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Убрать формулу' }).click();
    await expect(page.getByText('Формула убрана').first()).toBeVisible();
    await deleteItem(page, NAMES[0]!);
    await expect(row(NAMES[0]!)).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

async function deleteItem(page: Page, name: string) {
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Удалить' })
    .click();
  // the item goes with its grades: asked first
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
}
