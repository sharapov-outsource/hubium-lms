import { expect, type Page, test } from '@playwright/test';
import { demoCourse } from '../node/helpers';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { contextAt, expectMode } from './helpers';
import {
  branchServer,
  cloudServer,
  installer,
  link,
  loadImages,
  nodeStatus,
  UPGRADE_IMAGE,
  UPGRADE_VERSION,
} from './lab';

// The cloud is upgraded to its next release while branch 1 works alone. Branch 2, on the
// line, passes everything to the cloud until it runs the same release, then follows it with
// install-hubium.sh node-update (the timer runs it on a server with systemd). Branch 1 comes
// back with its journal of the old release: the cloud takes it, and the node follows too.

async function reply(page: Page, text: string) {
  const ids = await demoCourse();
  const [d] = await sql<{ id: string }>(
    `SELECT id FROM "ForumDiscussion" WHERE "activityId" = $1 ORDER BY "createdAt" LIMIT 1`,
    [ids.forumId],
  );
  await page.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${d!.id}`);
  await page.getByRole('button', { name: 'Ответить' }).first().click();
  await page.locator('[id^="msg-"]').first().click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('[id^="msg-"]')).toHaveCount(0);
  await expect(page.getByText(text)).toBeVisible();
}

test('the cloud upgraded while a branch works alone', async ({ page }) => {
  test.setTimeout(2_400_000);
  for (const server of [cloudServer, branchServer(1), branchServer(2)])
    loadImages(server, [UPGRADE_IMAGE]);
  await expectMode(1, 'ONLINE', 300_000);
  await expectMode(2, 'ONLINE', 300_000);
  await login(page, 'student1', DEMO_PASSWORD);
  link(1, 'down');
  await expectMode(1, 'OFFLINE', 300_000);
  const mark = `До обновления облака ${Date.now().toString(36)}`;
  await reply(page, mark);

  installer(cloudServer, ['upgrade', '--version', UPGRADE_VERSION, '--backup', 'no']);

  // branch 2 passes everything on until it runs the cloud's release; its people work on
  await expectMode(2, 'PASSTHROUGH', 300_000);
  const branch2 = await contextAt(2);
  const p2 = await branch2.newPage();
  await login(p2, 'student2', DEMO_PASSWORD);
  await expect(p2.getByRole('link', { name: /Python для начинающих/ }).first()).toBeVisible();
  installer(branchServer(2), ['node-update']);
  await expectMode(2, 'ONLINE', 600_000);
  expect(nodeStatus(2).release).toMatch(new RegExp(`^${UPGRADE_VERSION}\\+`));
  await branch2.close();

  // branch 1 comes back: its journal goes to the upgraded cloud, then it follows
  link(1, 'up');
  await expect
    .poll(
      async () =>
        (
          await sql<{ n: number }>(
            `SELECT count(*)::int AS n FROM "ForumPost" WHERE "contentHtml" LIKE $1`,
            [`%${mark}%`],
          )
        )[0]?.n,
      { timeout: 600_000, intervals: [5000] },
    )
    .toBe(1);
  installer(branchServer(1), ['node-update']);
  await expectMode(1, 'ONLINE', 600_000);
  expect(nodeStatus(1).release).toMatch(new RegExp(`^${UPGRADE_VERSION}\\+`));
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: /Python для начинающих/ }).first()).toBeVisible();
});
