import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';

// The demo literature course as the seed leaves it: its weeks and subsections, and the
// SCORM and H5P samples it carries play in their players and count for the learner.

async function demoActivity(moduleKey: string) {
  const [row] = await sql<{ course: string; id: string }>(
    `SELECT c.id AS course, a.id FROM "Activity" a JOIN "Course" c ON c.id = a."courseId"
      WHERE c."shortName" = 'DEMO-LIT' AND a."moduleKey" = $1 AND a."deletedAt" IS NULL`,
    [moduleKey],
  );
  return `/course/${row!.course}/a/${row!.id}`;
}

test('the demo literature course: its samples of SCORM and H5P play for a learner', async ({
  page,
}) => {
  await login(page, 'student2', DEMO_PASSWORD);

  const h5p = await demoActivity('h5p');
  await page.goto(h5p.replace(/\/a\/.*/, ''));
  for (const name of ['А. П. Чехов', 'Рассказы', 'Пьесы'])
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();

  await page.goto(h5p);
  const quiz = page
    .frameLocator('iframe[title="Рассказы Чехова: самопроверка"]')
    .frameLocator('iframe.h5p-iframe');
  for (const answer of ['Греческий язык', 'Об усадьбе с крыжовником', 'Земским врачом'])
    await quiz.getByLabel(answer).check();
  await quiz.getByRole('button', { name: 'Проверить' }).click();
  await expect(quiz.getByText('Верных ответов: 3 из 3.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Оценка: 10 из 10')).toBeVisible();
  await expectAccessible(page);

  const scorm = await demoActivity('scorm');
  await page.goto(scorm);
  const sco = page.frameLocator('iframe[title="Проверьте себя"]').frameLocator('#sco');
  for (const [i, answer] of ['Ермолай Лопахин', 'Петя Трофимов', 'Комедия'].entries())
    await sco.getByRole('group').nth(i).getByLabel(answer).check();
  await sco.getByRole('button', { name: 'Проверить' }).click();
  await expect(sco.getByText('Верных ответов: 3 из 3 (100 %).')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Балл: 100%')).toBeVisible();
  await expectAccessible(page);
});
