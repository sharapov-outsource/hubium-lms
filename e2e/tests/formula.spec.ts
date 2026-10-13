import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// A formula typed in the editor is stored as LaTeX and drawn by KaTeX on the page, with the
// stylesheet and fonts from this origin (no CSP violations).

test('teacher writes a formula; the page shows it rendered', async ({ page }) => {
  const [c] = await sql<{ id: string; section: string }>(
    `SELECT c.id, (SELECT id FROM "CourseSection" WHERE "courseId" = c.id ORDER BY rank LIMIT 1) AS section
       FROM "Course" c WHERE c."shortName" = 'DEMO-PY'`,
  );
  const name = `Формулы ${Date.now().toString(36)}`;
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text());
  });
  // the demo course is shared by every spec: leave it as found
  try {
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`/course/${c!.id}/a/new?module=page&section=${c!.section}`);
    await page.locator('#f-name').fill(name);
    await page.locator('[id="f-settings-content"]').first().click();
    await page.keyboard.type('Площадь круга: ');
    await page
      .getByRole('toolbar', { name: 'Содержимое' })
      .getByRole('button', { name: 'Формула' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('S = \\pi r^2');
    await expect(dialog.locator('.katex').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Вставить' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: /^Создать$/ }).click();
    await page.waitForURL(/\?edit=1#a-/);
    const id = new URL(page.url()).hash.slice('#a-'.length);
    await page.goto(`/course/${c!.id}/a/${id}`);
    const formula = page.locator('.prose-content [data-type="inline-math"] .katex');
    await expect(formula).toBeVisible();
    await expect(formula.locator('annotation')).toHaveText('S = \\pi r^2');
    await expectAccessible(page);
    expect(violations).toEqual([]);
  } finally {
    await sql(`DELETE FROM "Context" WHERE id IN (SELECT id FROM "Activity" WHERE name = $1)`, [
      name,
    ]);
  }
});
