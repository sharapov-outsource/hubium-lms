import { expect, test } from '@playwright/test';
import { demoCourse } from '../node/helpers';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { contextAt, expectMode } from './helpers';
import { cloudCompose, installNode, link, startBranch } from './lab';

// A second branch, its node installed with a code from the cloud's command line. Both lose
// their lines at once and the same student takes a quiz of one attempt in each; both lines
// come back together. The cloud takes one journal after the other: the attempt replayed
// second is over the limit and becomes a conflict the teacher accepts.

const STUDENT = 'student2';

test('two branches without a connection at once, back together', async () => {
  test.setTimeout(2_400_000);
  const { code } = JSON.parse(
    cloudCompose(['exec', '-T', 'web', 'hubium', 'nodes', 'add', '--name', 'Филиал 2', '--json']),
  ) as { code: string };
  await startBranch(2);
  installNode(2, code);
  await expectMode(2, 'ONLINE', 900_000);

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
    await expectMode(1, 'ONLINE');
    link(1, 'down');
    link(2, 'down');
    await Promise.all([expectMode(1, 'OFFLINE', 300_000), expectMode(2, 'OFFLINE', 300_000)]);

    const attempts: string[] = [];
    for (const i of [1, 2]) {
      const context = await contextAt(i);
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

    link(1, 'up');
    link(2, 'up');
    await Promise.all([expectMode(1, 'ONLINE', 600_000), expectMode(2, 'ONLINE', 600_000)]);
    const taken = await sql<{ state: string }>(
      `SELECT state FROM "QuizAttempt" WHERE id = ANY($1::uuid[])`,
      [attempts],
    );
    expect(taken.map((a) => a.state)).toEqual(['FINISHED']);
    const conflicts = await sql<{ id: string }>(
      `SELECT c.id FROM "NodeConflict" c JOIN "User" u ON u.id = c."actorId"
        WHERE c."activityId" = $1 AND u.username = $2 AND c.status = 'OPEN'
        ORDER BY c."createdAt"`,
      [ids.quizId, STUDENT],
    );
    expect(conflicts.length).toBeGreaterThan(0);
    // both outages are in the cloud's log
    const outages = await sql<{ name: string }>(
      `SELECT n.name FROM "NodeOutage" o JOIN "Node" n ON n.id = o."nodeId"
        WHERE o."endedAt" IS NOT NULL AND o."startedAt" > now() - interval '30 minutes'
        GROUP BY n.name ORDER BY n.name`,
    );
    expect(outages.map((o) => o.name)).toEqual(['Филиал 1', 'Филиал 2']);

    // the teacher, in the cloud, takes the extra attempt
    const context = await contextAt('cloud');
    const teacher = await context.newPage();
    await login(teacher, 'teacher', DEMO_PASSWORD);
    await teacher.goto(`/node-conflicts/${conflicts[0]!.id}`);
    await teacher.getByRole('button', { name: 'Принять' }).click();
    await teacher.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
    await expect(teacher.getByText('Принято').first()).toBeVisible();
    await expect
      .poll(async () =>
        (
          await sql<{ state: string }>(
            `SELECT state FROM "QuizAttempt" WHERE id = ANY($1::uuid[])`,
            [attempts],
          )
        ).map((r) => r.state),
      )
      .toEqual(['FINISHED', 'FINISHED']);
    await context.close();
  } finally {
    link(1, 'up');
    link(2, 'up');
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [ids.quizId, quiz!.settings]);
    await clear();
  }
});
