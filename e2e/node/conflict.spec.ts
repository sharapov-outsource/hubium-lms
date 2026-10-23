import { expect, test } from '@playwright/test';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { demoCourse, waitForMode } from './helpers';
import { link, nodeUrl } from './stack';

// A teacher's change made without a connection that the cloud does not take: the teacher
// corrects a student's post on the node while the same post is changed in the cloud. After
// the sync the cloud keeps its own text, the teacher is told, and accepting the conflict
// puts the teacher's text in.

test.use({ baseURL: nodeUrl(1) });

test('a change the cloud did not take becomes a conflict the teacher accepts', async ({ page }) => {
  const ids = await demoCourse();
  const [post] = await sql<{ id: string; discussionId: string; html: string }>(
    `SELECT p.id, p."discussionId", p."contentHtml" AS html FROM "ForumPost" p
       JOIN "ForumDiscussion" d ON d.id = p."discussionId"
      WHERE d."activityId" = $1 AND p."parentId" IS NULL AND p."deletedAt" IS NULL
      ORDER BY p."createdAt" LIMIT 1`,
    [ids.forumId],
  );
  const restore = () =>
    sql(`UPDATE "ForumPost" SET "contentHtml" = $2, "editedAt" = NULL WHERE id = $1`, [
      post!.id,
      post!.html,
    ]);
  await sql(`DELETE FROM "NodeConflict" WHERE "activityId" = $1`, [ids.forumId]);
  try {
    await waitForMode(1, 'ONLINE');
    await login(page, 'teacher', DEMO_PASSWORD);
    await link(1, 'refuse');
    await waitForMode(1, 'OFFLINE');

    await page.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${post!.discussionId}`);
    await page.getByRole('button', { name: 'Редактировать' }).first().click();
    const editor = page.locator(`[id="msg-${post!.id}"]`);
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Исправлено преподавателем без связи');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Исправлено преподавателем без связи')).toBeVisible();

    // meanwhile the post changes in the cloud
    await sql(
      `UPDATE "ForumPost" SET "contentHtml" = '<p>Исправлено в облаке</p>', "editedAt" = now()
        WHERE id = $1`,
      [post!.id],
    );

    await link(1, 'up');
    await waitForMode(1, 'ONLINE', 180_000);
    const [cloud] = await sql<{ html: string }>(
      `SELECT "contentHtml" AS html FROM "ForumPost" WHERE id = $1`,
      [post!.id],
    );
    expect(cloud?.html).toContain('Исправлено в облаке');
    const [conflict] = await sql<{ id: string; status: string }>(
      `SELECT c.id, c.status FROM "NodeConflict" c
         JOIN "User" u ON u.id = c."actorId"
        WHERE c."activityId" = $1 AND u.username = 'teacher'`,
      [ids.forumId],
    );
    expect(conflict?.status).toBe('OPEN');
    const [note] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Notification" n JOIN "User" u ON u.id = n."userId"
        WHERE u.username = 'teacher' AND n.type = 'node.conflict' AND n."createdAt" > now() - interval '10 minutes'`,
    );
    expect(note?.n).toBeGreaterThan(0);

    // the teacher reads it through the node and accepts it
    await page.goto(`/node-conflicts/${conflict!.id}`);
    await page.getByText('Содержимое', { exact: true }).click();
    await expect(page.getByText(/Исправлено преподавателем без связи/)).toBeVisible();
    await page.getByRole('button', { name: 'Принять' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByText('Принято').first()).toBeVisible();
    await expect
      .poll(async () => {
        const [r] = await sql<{ html: string }>(
          `SELECT "contentHtml" AS html FROM "ForumPost" WHERE id = $1`,
          [post!.id],
        );
        return r?.html ?? '';
      })
      .toContain('Исправлено преподавателем без связи');
    const [after] = await sql<{ status: string }>(
      `SELECT status FROM "NodeConflict" WHERE id = $1`,
      [conflict!.id],
    );
    expect(after?.status).toBe('ACCEPTED');
  } finally {
    await link(1, 'up');
    await restore();
  }
});
