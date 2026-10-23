import { expect, test } from '@playwright/test';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { demoCourse, waitForMode } from './helpers';
import { CLOUD, link, nodeUrl } from './stack';

// Two branches without a connection at once, and the same student in both: a quiz with one
// attempt is taken in each. When both lines come back, the nodes' journals are replayed one
// after the other; the attempt replayed second is over the limit and becomes a conflict,
// which the teacher accepts. Nothing done in either branch is lost.

const STUDENT = 'student2';

test('the same student in two branches without a connection', async ({ browser }) => {
  test.skip(Number(process.env.NODES ?? 2) < 2, 'needs two nodes');
  const ids = await demoCourse();
  const [quiz] = await sql<{ settings: object }>(`SELECT settings FROM "Activity" WHERE id = $1`, [
    ids.quizId,
  ]);
  const clear = () =>
    sql(
      `DELETE FROM "QuizAttempt" WHERE "activityId" = $1
         AND "userId" = (SELECT id FROM "User" WHERE username = $2)`,
      [ids.quizId, STUDENT],
    );
  await clear();
  await sql(`DELETE FROM "NodeConflict" WHERE "activityId" = $1`, [ids.quizId]);
  await sql(`UPDATE "Activity" SET settings = settings || '{"attempts": 1}' WHERE id = $1`, [
    ids.quizId,
  ]);
  try {
    await waitForMode(1, 'ONLINE');
    await waitForMode(2, 'ONLINE');
    await Promise.all([link(1, 'refuse'), link(2, 'refuse')]);
    await Promise.all([waitForMode(1, 'OFFLINE'), waitForMode(2, 'OFFLINE')]);

    const attempts: string[] = [];
    for (const i of [1, 2]) {
      const context = await browser.newContext({ baseURL: nodeUrl(i) });
      const page = await context.newPage();
      await login(page, STUDENT, DEMO_PASSWORD);
      await page.goto(`/course/${ids.courseId}/a/${ids.quizId}`);
      await page.getByRole('button', { name: 'Начать попытку' }).click();
      await page.waitForURL(/attempt=/);
      attempts.push(new URL(page.url()).searchParams.get('attempt')!);
      await page.getByLabel('float', { exact: true }).check();
      await page.getByRole('button', { name: 'Далее' }).click();
      await expect(page.getByRole('heading', { name: 'Вопрос 4' })).toBeVisible();
      await page.getByRole('button', { name: 'Завершить попытку' }).first().click();
      await page.getByRole('button', { name: 'Завершить попытку' }).last().click();
      await expect(page.getByText(/Ваша оценка:/)).toBeVisible();
      await context.close();
    }

    // both lines come back at once: one journal after the other
    await Promise.all([link(1, 'up'), link(2, 'up')]);
    await Promise.all([waitForMode(1, 'ONLINE', 240_000), waitForMode(2, 'ONLINE', 240_000)]);
    const inCloud = await sql<{ id: string; state: string }>(
      `SELECT id, state FROM "QuizAttempt" WHERE id = ANY($1::uuid[])`,
      [attempts],
    );
    expect(inCloud).toHaveLength(1);
    expect(inCloud[0]?.state).toBe('FINISHED');
    const conflicts = await sql<{ id: string; status: string }>(
      `SELECT c.id, c.status FROM "NodeConflict" c JOIN "User" u ON u.id = c."actorId"
        WHERE c."activityId" = $1 AND u.username = $2 AND c.status = 'OPEN'
        ORDER BY c."createdAt"`,
      [ids.quizId, STUDENT],
    );
    expect(conflicts.length).toBeGreaterThan(0);

    // the teacher takes the extra attempt in the cloud
    const context = await browser.newContext({ baseURL: CLOUD.url });
    const teacher = await context.newPage();
    await login(teacher, 'teacher', DEMO_PASSWORD);
    await teacher.goto(`/course/${ids.courseId}/node-conflicts`);
    await teacher.goto(`/node-conflicts/${conflicts[0]!.id}`);
    await teacher.getByRole('button', { name: 'Принять' }).click();
    await teacher.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
    await expect(teacher.getByText('Принято').first()).toBeVisible();
    await expect
      .poll(async () => {
        const rows = await sql<{ state: string }>(
          `SELECT state FROM "QuizAttempt" WHERE id = ANY($1::uuid[])`,
          [attempts],
        );
        return rows.map((r) => r.state);
      })
      .toEqual(['FINISHED', 'FINISHED']);
    await context.close();
  } finally {
    await Promise.all([link(1, 'up'), link(2, 'up')]);
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [ids.quizId, quiz!.settings]);
    await clear();
  }
});
