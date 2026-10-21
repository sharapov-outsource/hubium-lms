import { expect, test } from '@playwright/test';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { ATTEMPT_RESULT, demoCourse, nodeSql, waitForMode } from './helpers';
import { link, nodeUrl } from './stack';

// A quiz through the local node of a branch: started while connected, finished while the
// line to the cloud is down, and in the cloud once the line is back.

const STUDENT = 'student3';

test.use({ baseURL: nodeUrl(1) });

test('a quiz started online and finished during an outage reaches the cloud', async ({ page }) => {
  const ids = await demoCourse();
  await sql(
    `DELETE FROM "QuizAttempt" WHERE "activityId" = $1
       AND "userId" = (SELECT id FROM "User" WHERE username = $2)`,
    [ids.quizId, STUDENT],
  );
  await waitForMode(1, 'ONLINE');
  await login(page, STUDENT, DEMO_PASSWORD);
  await page.goto(`/course/${ids.courseId}/a/${ids.quizId}`);
  await page.getByRole('button', { name: 'Начать попытку' }).click();
  await page.waitForURL(/attempt=/);
  const attemptId = new URL(page.url()).searchParams.get('attempt')!;
  // the attempt was started in the cloud, and the node shows it at once
  const [started] = await sql<{ state: string }>(`SELECT state FROM "QuizAttempt" WHERE id = $1`, [
    attemptId,
  ]);
  expect(started?.state).toBe('IN_PROGRESS');
  await page.getByLabel('float', { exact: true }).check();
  await page.getByLabel('Верно', { exact: true }).check();
  await page.getByRole('textbox', { name: 'Ваш ответ' }).first().fill('print');
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.getByRole('heading', { name: 'Вопрос 4' })).toBeVisible();

  // the line goes down: a while of reading only, then the node works on its own
  await link(1, 'down');
  await waitForMode(1, 'OFFLINE');
  await page.reload();
  await expect(page.locator('[data-node-mode="OFFLINE"]')).toBeVisible();
  await page.getByRole('textbox', { name: 'Ваш ответ' }).first().fill('3');
  await page.getByRole('button', { name: 'Завершить попытку' }).first().click();
  await page.getByRole('button', { name: 'Завершить попытку' }).last().click();
  await expect(page.getByText('Ваша оценка: 6.67 из 10')).toBeVisible();
  // the cloud does not know of it yet
  const [during] = await sql<{ state: string }>(`SELECT state FROM "QuizAttempt" WHERE id = $1`, [
    attemptId,
  ]);
  expect(during?.state).toBe('IN_PROGRESS');
  // what the node made of it: the cloud must come to the same (the double run)
  const [onNode] = await nodeSql<{ result: unknown }>(1, ATTEMPT_RESULT, [attemptId]);

  // the line is back: the journal goes to the cloud, and the node reads the cloud again
  await link(1, 'up');
  await waitForMode(1, 'ONLINE', 180_000);
  const [after] = await sql<{ state: string; sumGrades: string }>(
    `SELECT state, "sumGrades"::text AS "sumGrades" FROM "QuizAttempt" WHERE id = $1`,
    [attemptId],
  );
  expect(after?.state).toBe('FINISHED');
  const [inCloud] = await sql<{ result: unknown }>(ATTEMPT_RESULT, [attemptId]);
  expect(inCloud?.result).toEqual(onNode?.result);
  await page.goto(`/course/${ids.courseId}/a/${ids.quizId}?review=${attemptId}`);
  await expect(page.getByText('Ваша оценка: 6.67 из 10')).toBeVisible();
  await expect(page.locator('[data-node-mode]')).toHaveCount(0);
});
