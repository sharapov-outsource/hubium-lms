import { expect, test } from '@playwright/test';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { demoCourse, waitForMode } from './helpers';
import { link, nodeState, nodeUrl } from './stack';

// A line that keeps dropping for a few seconds: the node notices each drop and reads only
// while it lasts, and goes back to the cloud each time, without working on its own (that
// takes longer than NODE_OFFLINE_AFTER). What people send between the drops goes to the
// cloud.

test.use({ baseURL: nodeUrl(1) });

test('short drops of the line do not make the node work alone', async ({ page }) => {
  const ids = await demoCourse();
  const [discussion] = await sql<{ id: string }>(
    `SELECT id FROM "ForumDiscussion" WHERE "activityId" = $1 ORDER BY "createdAt" LIMIT 1`,
    [ids.forumId],
  );
  await waitForMode(1, 'ONLINE');
  await login(page, 'student1', DEMO_PASSWORD);
  const modes = new Set<string>();
  const watch = setInterval(() => {
    nodeState(1)
      .then((s) => modes.add(s.mode))
      .catch(() => {});
  }, 300);
  const mark = `Между обрывами ${Date.now().toString(36)}`;
  try {
    for (let n = 1; n <= 4; n++) {
      await link(1, 'refuse');
      await waitForMode(1, 'READONLY', 60_000);
      await link(1, 'up');
      await waitForMode(1, 'ONLINE', 60_000);
      await page.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${discussion!.id}`);
      await page.getByRole('button', { name: 'Ответить' }).first().click();
      await page.locator('[id^="msg-"]').first().click();
      await page.keyboard.type(`${mark} №${n}`);
      await page.getByRole('button', { name: 'Отправить' }).click();
      // taken: the form closes and the post shows
      await expect(page.locator('[id^="msg-"]')).toHaveCount(0);
      await expect(page.getByText(`${mark} №${n}`)).toBeVisible();
    }
  } finally {
    clearInterval(watch);
    await link(1, 'up');
  }
  expect(modes.has('OFFLINE')).toBe(false);
  expect((await nodeState(1)).replicaB).not.toBe('promoted');
  const [posts] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM "ForumPost" WHERE "discussionId" = $1 AND "contentHtml" LIKE $2`,
    [discussion!.id, `%${mark}%`],
  );
  expect(posts?.n).toBe(4);
});
