import { type Browser, expect, type Page, test } from '@playwright/test';
import { ATTEMPT_RESULT, demoCourse } from '../node/helpers';
import { sql } from '../tests/db';
import { ADMIN, DEMO_PASSWORD, login } from '../tests/helpers';
import { branchSql, expectMode } from './helpers';
import { link } from './lab';

// A lesson in the branch while its line to the cloud is cut, the packets dropped as on a
// real outage. Before it a student hands in work with a file; during it people sign in with
// their passwords, post, write the wiki and the glossary, take a quiz from start to finish,
// and the teacher grades; site administration waits for the line. Once the line is back
// everything is in the cloud, once, and the cloud's quiz attempt is the node's.

async function as(browser: Browser, user: string, password = DEMO_PASSWORD): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, user, password);
  return page;
}

const bannerText = (page: Page) => page.locator('[data-node-mode]').first();

test('a lesson without a connection reaches the cloud once the line is back', async ({
  browser,
}) => {
  test.setTimeout(1_800_000);
  // whatever an earlier run left on the node is in the cloud first
  await expectMode(1, 'ONLINE', 600_000);
  const py = await demoCourse();
  const [lit] = await sql<{ courseId: string; glossaryId: string; wikiId: string }>(
    `SELECT c.id AS "courseId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'glossary'
               AND "deletedAt" IS NULL LIMIT 1) AS "glossaryId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'wiki'
               AND "deletedAt" IS NULL LIMIT 1) AS "wikiId"
       FROM "Course" c WHERE c."shortName" = 'DEMO-LIT'`,
  );
  const [student3] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = 'student3'`);
  for (const table of ['QuizAttempt'])
    await sql(`DELETE FROM "${table}" WHERE "activityId" = $1 AND "userId" = $2`, [
      py.quizId,
      student3!.id,
    ]);
  for (const table of ['AssignGrade', 'AssignSubmission'])
    await sql(`DELETE FROM "${table}" WHERE "activityId" = $1 AND "userId" = $2`, [
      py.assignId,
      student3!.id,
    ]);
  const [discussion] = await sql<{ id: string }>(
    `SELECT id FROM "ForumDiscussion" WHERE "activityId" = $1 ORDER BY "createdAt" LIMIT 1`,
    [py.forumId],
  );
  const mark = `Без связи ${Date.now().toString(36)}`;
  await expectMode(1, 'ONLINE');
  try {
    await lesson();
  } finally {
    link(1, 'up');
  }

  async function lesson() {
    // with the line: work with a file goes through the node to the cloud
    const s3 = await as(browser, 'student3');
    await s3.goto(`/course/${py.courseId}/a/${py.assignId}`);
    await s3.locator('#assign-text').click();
    await s3.keyboard.type(`Решение: ${mark}`);
    await s3.locator('#assign-files').setInputFiles({
      name: 'solution.py',
      mimeType: 'text/x-python',
      buffer: Buffer.from('def add(a, b):\n    return a + b\n'),
    });
    await s3.getByRole('button', { name: 'Отправить на проверку' }).first().click();
    const confirm = s3.getByRole('button', { name: 'Отправить на проверку' }).last();
    if (await confirm.isVisible()) await confirm.click();
    await expect(s3.getByText('Отправлено на проверку').first()).toBeVisible();
    const [submitted] = await sql<{ status: string }>(
      `SELECT status::text FROM "AssignSubmission" WHERE "activityId" = $1 AND "userId" = $2 AND latest`,
      [py.assignId, student3!.id],
    );
    expect(submitted?.status).toBe('SUBMITTED');

    // the line is cut: reading only at first, then the node works on its own
    link(1, 'down');
    await expectMode(1, 'READONLY', 120_000);
    await s3.reload();
    await expect(bannerText(s3)).toContainText('Пока можно просматривать материалы');
    await expectMode(1, 'OFFLINE', 300_000);
    await s3.reload();
    await expect(bannerText(s3)).toContainText('Работа сохраняется на сервере организации');

    // signing in with a password works without the cloud
    const s1 = await as(browser, 'student1');
    const s2 = await as(browser, 'student2');
    const teacher = await as(browser, 'teacher');

    // a forum post
    await s1.goto(`/course/${py.courseId}/a/${py.forumId}?d=${discussion!.id}`);
    await s1.getByRole('button', { name: 'Ответить' }).first().click();
    await s1.locator('[id^="msg-"]').first().click();
    await s1.keyboard.type(`Форум: ${mark}`);
    await s1.getByRole('button', { name: 'Отправить' }).click();
    await expect(s1.locator('[id^="msg-"]')).toHaveCount(0);
    await expect(s1.getByText(`Форум: ${mark}`)).toBeVisible();

    // a glossary entry and a wiki edit
    await s2.goto(`/course/${lit!.courseId}/a/${lit!.glossaryId}`);
    await s2.getByRole('link', { name: 'Добавить статью' }).first().click();
    await s2.getByLabel('Понятие', { exact: true }).fill(`Глоссарий ${mark}`);
    await s2.locator('#f-definition .ProseMirror, [id="f-definition"]').first().click();
    await s2.keyboard.type('Написано в филиале без связи.');
    await s2.getByRole('button', { name: 'Сохранить' }).click();
    await expect(s2.getByText('Статья сохранена').first()).toBeVisible();
    await s2.goto(`/course/${lit!.courseId}/a/${lit!.wikiId}`);
    await s2.getByRole('link', { name: 'Правка' }).first().click();
    await s2.locator('#f-content .ProseMirror, [id="f-content"]').first().click();
    await s2.keyboard.press('End');
    await s2.keyboard.type(` Вики: ${mark}`);
    await s2.getByRole('button', { name: 'Сохранить' }).click();
    await expect(s2.getByText('Страница сохранена').first()).toBeVisible();

    // a quiz from start to finish
    await s3.goto(`/course/${py.courseId}/a/${py.quizId}`);
    await s3.getByRole('button', { name: 'Начать попытку' }).click();
    await s3.waitForURL(/attempt=/);
    const attemptId = new URL(s3.url()).searchParams.get('attempt')!;
    await s3.getByLabel('float', { exact: true }).check();
    await s3.getByLabel('Верно', { exact: true }).check();
    await s3.getByRole('textbox', { name: 'Ваш ответ' }).first().fill('print');
    await s3.getByRole('button', { name: 'Далее' }).click();
    await expect(s3.getByRole('heading', { name: 'Вопрос 4' })).toBeVisible();
    await s3.getByRole('textbox', { name: 'Ваш ответ' }).first().fill('3');
    await s3.getByRole('button', { name: 'Завершить попытку' }).first().click();
    await s3.getByRole('button', { name: 'Завершить попытку' }).last().click();
    await expect(s3.getByText('Ваша оценка: 6.67 из 10')).toBeVisible();

    // the teacher grades the work handed in before the outage
    await teacher.goto(`/course/${py.courseId}/a/${py.assignId}`);
    await teacher
      .getByRole('row')
      .filter({ hasText: 'Пётр Иванов' })
      .getByRole('link', { name: 'Оценить' })
      .click();
    await expect(teacher.getByText(`Решение: ${mark}`)).toBeVisible();
    await teacher.locator('#assign-grade').fill('9');
    await teacher.locator('#assign-feedback').click();
    await teacher.keyboard.type(`Отзыв: ${mark}`);
    await teacher.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
    await expect(teacher.getByText('Оценка сохранена').first()).toBeVisible();

    // site administration waits for the line
    const admin = await as(browser, ADMIN.login, ADMIN.password);
    await admin.goto('/admin/settings');
    await admin.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(
      admin.getByText('Для этого нужна связь с основным сервером').first(),
    ).toBeVisible();

    // none of it is in the cloud yet; the node has it, and its version of the attempt
    const inCloud = async () =>
      (
        await sql<{ n: number }>(
          `SELECT (SELECT count(*) FROM "ForumPost" WHERE "contentHtml" LIKE $1)
              + (SELECT count(*) FROM "GlossaryEntry" WHERE concept LIKE $1)
              + (SELECT count(*) FROM "WikiVersion" WHERE content LIKE $1)
              + (SELECT count(*) FROM "AssignGrade" WHERE feedback LIKE $1)
              + (SELECT count(*) FROM "QuizAttempt" WHERE id = $2 AND state = 'FINISHED') AS n`,
          [`%${mark}%`, attemptId],
        )
      )[0]?.n;
    expect(Number(await inCloud())).toBe(0);
    const [onNode] = branchSql<{ result: unknown }>(
      1,
      ATTEMPT_RESULT.replaceAll('$1', `'${attemptId}'::uuid`),
    );

    // the line is back: the journal goes to the cloud
    link(1, 'up');
    await expectMode(1, 'ONLINE', 600_000);
    expect(Number(await inCloud())).toBe(5);
    const [cloudAttempt] = await sql<{ result: unknown }>(ATTEMPT_RESULT, [attemptId]);
    expect(cloudAttempt?.result).toEqual(onNode?.result);
    const [grade] = await sql<{ grade: string }>(
      `SELECT grade::text FROM "AssignGrade" WHERE "activityId" = $1 AND "userId" = $2`,
      [py.assignId, student3!.id],
    );
    expect(Number(grade?.grade)).toBe(9);
    // the cloud logged the outage with what it took
    const [outage] = await sql<{ applied: number; conflicts: number; endedAt: Date | null }>(
      `SELECT applied, conflicts, "endedAt" FROM "NodeOutage" ORDER BY "startedAt" DESC LIMIT 1`,
    );
    expect(outage?.endedAt).not.toBeNull();
    expect(outage?.conflicts).toBe(0);
    expect(outage?.applied).toBeGreaterThan(5);
    // and the branch reads the cloud again, without a banner
    await s3.goto(`/course/${py.courseId}/a/${py.quizId}?review=${attemptId}`);
    await expect(s3.getByText('Ваша оценка: 6.67 из 10')).toBeVisible();
    await expect(s3.locator('[data-node-mode]')).toHaveCount(0);
  }
});
