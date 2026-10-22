import { expect, type Page, test } from '@playwright/test';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { demoCourse, waitForMode } from './helpers';
import { link, nodeUrl } from './stack';

// The line goes down again in the middle of the sync: the cloud has taken a batch of the
// journal but the node never hears back. The node sends the batch again once it can, and
// the cloud, which did each entry once, answers what it did: nothing is there twice.

test.use({ baseURL: nodeUrl(1) });

test('a sync cut off after the cloud took a batch finishes without doubles', async ({ page }) => {
  const ids = await demoCourse();
  const [discussion] = await sql<{ id: string }>(
    `SELECT id FROM "ForumDiscussion" WHERE "activityId" = $1 ORDER BY "createdAt" LIMIT 1`,
    [ids.forumId],
  );
  await waitForMode(1, 'ONLINE');
  await login(page, 'student3', DEMO_PASSWORD);
  await link(1, 'refuse');
  try {
    await waitForMode(1, 'OFFLINE');
    await offlineAndBack(page, ids, discussion!.id);
  } finally {
    await link(1, 'up');
  }
});

async function offlineAndBack(
  page: Page,
  ids: { courseId: string; forumId: string },
  discussionId: string,
) {
  const mark = `Ответ ${Date.now().toString(36)}`;
  await page.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${discussionId}`);
  for (let n = 1; n <= 3; n++) {
    await page.getByRole('button', { name: 'Ответить' }).first().click();
    await page.locator('[id^="msg-"]').first().click();
    await page.keyboard.type(`${mark} №${n}`);
    await page.getByRole('button', { name: 'Отправить' }).click();
    // taken: the form closes (until then the text is the editor's own) and the post shows
    await expect(page.locator('[id^="msg-"]')).toHaveCount(0);
    await expect(page.getByText(`${mark} №${n}`)).toBeVisible();
  }

  await link(1, 'lose-replay');
  await link(1, 'up');
  await waitForMode(1, 'ONLINE', 240_000);
  // the answer was lost once, and the batch went again
  expect(await link(1, 'up')).toBe(1);
  const posts = await sql<{ text: string }>(
    `SELECT "contentHtml" AS text FROM "ForumPost" WHERE "discussionId" = $1
        AND "contentHtml" LIKE $2 ORDER BY "createdAt"`,
    [discussionId, `%${mark}%`],
  );
  expect(posts.map((p) => p.text.replace(/<[^>]+>/g, ''))).toEqual([
    `${mark} №1`,
    `${mark} №2`,
    `${mark} №3`,
  ]);
  await page.reload();
  for (let n = 1; n <= 3; n++) await expect(page.getByText(`${mark} №${n}`)).toHaveCount(1);
}
