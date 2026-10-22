import { type Browser, expect, test } from '@playwright/test';
import { demoCourse } from '../node/helpers';
import { sql } from '../tests/db';
import { closeOpened, expectMode, signedIn } from './helpers';
import { link } from './lab';

// Work done in the branch without a connection that the cloud does not take, three ways:
// the teacher edits a post the cloud changed meanwhile, a student hands in work after the
// cloud closed the assignment, and a student whose enrolment the cloud suspended posts.
// Each becomes a conflict its author is told of; the teacher, through the node, accepts the
// first two (they are done as their authors did them) and dismisses the third.

const as = (browser: Browser, user: string) => signedIn(browser, user);
test.afterEach(closeOpened);

test('work the cloud did not take becomes conflicts the teacher decides', async ({ browser }) => {
  test.setTimeout(1_800_000);
  const ids = await demoCourse();
  const [post] = await sql<{ id: string; discussionId: string; html: string }>(
    `SELECT p.id, p."discussionId", p."contentHtml" AS html FROM "ForumPost" p
       JOIN "ForumDiscussion" d ON d.id = p."discussionId"
      WHERE d."activityId" = $1 AND p."parentId" IS NULL AND p."deletedAt" IS NULL
      ORDER BY p."createdAt" LIMIT 1`,
    [ids.forumId],
  );
  const [assign] = await sql<{ settings: unknown }>(
    `SELECT settings FROM "Activity" WHERE id = $1`,
    [ids.assignId],
  );
  const users = Object.fromEntries(
    (
      await sql<{ id: string; username: string }>(
        `SELECT id, username FROM "User" WHERE username IN ('teacher', 'student1', 'student2')`,
      )
    ).map((u) => [u.username, u.id]),
  );
  await sql(`DELETE FROM "NodeConflict" WHERE "activityId" = ANY($1::uuid[])`, [
    [ids.forumId, ids.assignId],
  ]);
  for (const table of ['AssignGrade', 'AssignSubmission'])
    await sql(`DELETE FROM "${table}" WHERE "activityId" = $1 AND "userId" = $2`, [
      ids.assignId,
      users.student1,
    ]);
  const mark = Date.now().toString(36);
  const restore = async () => {
    await sql(`UPDATE "ForumPost" SET "contentHtml" = $2, "editedAt" = NULL WHERE id = $1`, [
      post!.id,
      post!.html,
    ]);
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [
      ids.assignId,
      JSON.stringify(assign!.settings),
    ]);
    await sql(`UPDATE "Enrolment" SET status = 'ACTIVE' WHERE "courseId" = $1 AND "userId" = $2`, [
      ids.courseId,
      users.student2,
    ]);
  };

  try {
    await expectMode(1, 'ONLINE');
    const teacher = await as(browser, 'teacher');
    const s1 = await as(browser, 'student1');
    const s2 = await as(browser, 'student2');
    link(1, 'down');
    await expectMode(1, 'OFFLINE', 300_000);

    // on the node
    await teacher.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${post!.discussionId}`);
    await teacher.getByRole('button', { name: 'Редактировать' }).first().click();
    await teacher.locator(`[id="msg-${post!.id}"]`).click();
    await teacher.keyboard.press('ControlOrMeta+a');
    await teacher.keyboard.type(`Исправлено преподавателем ${mark}`);
    await teacher.getByRole('button', { name: 'Сохранить' }).click();
    await expect(teacher.getByText(`Исправлено преподавателем ${mark}`)).toBeVisible();

    await s1.goto(`/course/${ids.courseId}/a/${ids.assignId}`);
    await s1.locator('#assign-text').click();
    await s1.keyboard.type(`Сдано без связи ${mark}`);
    await s1.getByRole('button', { name: 'Отправить на проверку' }).first().click();
    const confirm = s1.getByRole('button', { name: 'Отправить на проверку' }).last();
    if (await confirm.isVisible()) await confirm.click();
    await expect(s1.getByText('Отправлено на проверку').first()).toBeVisible();

    await s2.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${post!.discussionId}`);
    await s2.getByRole('button', { name: 'Ответить' }).first().click();
    await s2.locator('[id^="msg-"]').first().click();
    await s2.keyboard.type(`Пишу после отчисления ${mark}`);
    await s2.getByRole('button', { name: 'Отправить' }).click();
    await expect(s2.locator('[id^="msg-"]')).toHaveCount(0);

    // meanwhile in the cloud
    await sql(`UPDATE "ForumPost" SET "contentHtml" = $2, "editedAt" = now() WHERE id = $1`, [
      post!.id,
      `<p>Исправлено в облаке ${mark}</p>`,
    ]);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    await sql(
      `UPDATE "Activity" SET settings = settings || jsonb_build_object('dueAt', $2::text, 'cutoffAt', $2::text)
        WHERE id = $1`,
      [ids.assignId, past],
    );
    await sql(
      `UPDATE "Enrolment" SET status = 'SUSPENDED' WHERE "courseId" = $1 AND "userId" = $2`,
      [ids.courseId, users.student2],
    );

    link(1, 'up');
    await expectMode(1, 'ONLINE', 600_000);

    // three conflicts, open; the cloud kept its own
    const conflicts = await sql<{ id: string; username: string; status: string }>(
      `SELECT c.id, u.username, c.status FROM "NodeConflict" c JOIN "User" u ON u.id = c."actorId"
        WHERE c."activityId" = ANY($1::uuid[]) ORDER BY u.username`,
      [[ids.forumId, ids.assignId]],
    );
    expect(conflicts.map((c) => [c.username, c.status])).toEqual([
      ['student1', 'OPEN'],
      ['student2', 'OPEN'],
      ['teacher', 'OPEN'],
    ]);
    const [cloudPost] = await sql<{ html: string }>(
      `SELECT "contentHtml" AS html FROM "ForumPost" WHERE id = $1`,
      [post!.id],
    );
    expect(cloudPost?.html).toContain(`Исправлено в облаке ${mark}`);
    const [told] = await sql<{ n: number }>(
      `SELECT count(DISTINCT "userId")::int AS n FROM "Notification"
        WHERE type = 'node.conflict' AND "userId" = ANY($1::uuid[])
          AND "createdAt" > now() - interval '30 minutes'`,
      [[users.teacher, users.student1, users.student2]],
    );
    expect(told?.n).toBe(3);

    // the teacher, through the node, decides in the course
    const decide = async (username: string, action: 'Принять' | 'Отклонить') => {
      const c = conflicts.find((x) => x.username === username)!;
      await teacher.goto(`/node-conflicts/${c.id}`);
      await teacher.getByRole('button', { name: action }).click();
      await teacher.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
      await expect(
        teacher.getByText(action === 'Принять' ? 'Принято' : 'Отклонено').first(),
      ).toBeVisible();
    };
    await teacher.goto(`/course/${ids.courseId}`);
    await teacher.getByRole('link', { name: 'Конфликты узлов' }).first().click();
    await expect(teacher.getByRole('row')).toHaveCount(4);
    await decide('teacher', 'Принять');
    await decide('student1', 'Принять');
    await decide('student2', 'Отклонить');

    const statuses = await sql<{ username: string; status: string }>(
      `SELECT u.username, c.status FROM "NodeConflict" c JOIN "User" u ON u.id = c."actorId"
        WHERE c."activityId" = ANY($1::uuid[]) ORDER BY u.username`,
      [[ids.forumId, ids.assignId]],
    );
    expect(statuses.map((c) => [c.username, c.status])).toEqual([
      ['student1', 'ACCEPTED'],
      ['student2', 'DISMISSED'],
      ['teacher', 'ACCEPTED'],
    ]);
    await expect
      .poll(async () => {
        const [r] = await sql<{ html: string }>(
          `SELECT "contentHtml" AS html FROM "ForumPost" WHERE id = $1`,
          [post!.id],
        );
        return r?.html ?? '';
      })
      .toContain(`Исправлено преподавателем ${mark}`);
    const [handedIn] = await sql<{ status: string; text: string }>(
      `SELECT status::text, "onlineText" AS text FROM "AssignSubmission"
        WHERE "activityId" = $1 AND "userId" = $2 AND latest`,
      [ids.assignId, users.student1],
    );
    expect(handedIn?.status).toBe('SUBMITTED');
    expect(handedIn?.text).toContain(`Сдано без связи ${mark}`);
    const [dismissed] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ForumPost" WHERE "contentHtml" LIKE $1`,
      [`%Пишу после отчисления ${mark}%`],
    );
    expect(dismissed?.n).toBe(0);
  } finally {
    link(1, 'up');
    await restore();
  }
});
