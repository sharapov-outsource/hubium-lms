import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { demoCourse, waitForMode } from './helpers';
import { link, nodeUrl, WORK } from './stack';

// A node away longer than the cloud keeps WAL for it (NODE_WAL_KEEP, 256MB in the stack):
// its replication slot is lost. Once back, the node sends its journal as always, gets a
// new slot and copies the cloud's database anew; what was done on it reaches the cloud.

test.use({ baseURL: nodeUrl(1) });

test('a node away longer than the cloud keeps WAL for copies the database anew', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const ids = await demoCourse();
  const { database } = JSON.parse(readFileSync(path.join(WORK, 'n1', 'node.json'), 'utf8')) as {
    database: { slot: string };
  };
  const slot = async () =>
    (
      await sql<{ s: string | null }>(
        `SELECT wal_status AS s FROM pg_replication_slots WHERE slot_name = $1`,
        [database.slot],
      )
    )[0]?.s ?? null;
  const [discussion] = await sql<{ id: string }>(
    `SELECT id FROM "ForumDiscussion" WHERE "activityId" = $1 ORDER BY "createdAt" LIMIT 1`,
    [ids.forumId],
  );
  await waitForMode(1, 'ONLINE');
  await login(page, 'student2', DEMO_PASSWORD);
  await link(1, 'refuse');
  try {
    await waitForMode(1, 'OFFLINE');
    const mark = `После долгого обрыва ${Date.now().toString(36)}`;
    await page.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${discussion!.id}`);
    await page.getByRole('button', { name: 'Ответить' }).first().click();
    await page.locator('[id^="msg-"]').first().click();
    await page.keyboard.type(mark);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expect(page.locator('[id^="msg-"]')).toHaveCount(0);
    await expect(page.getByText(mark)).toBeVisible();

    // the cloud writes more WAL than it keeps for a silent node
    await sql(`DROP TABLE IF EXISTS wal_filler`);
    await sql(
      `CREATE TABLE wal_filler AS SELECT g, ${Array.from({ length: 12 }, () => 'md5(random()::text)').join(' || ')} AS x
         FROM generate_series(1, 500000) g`,
    );
    await sql(`SELECT pg_switch_wal()`);
    // a checkpoint removes the WAL the slot no longer holds, the next one finds it lost
    await expect
      .poll(
        async () => {
          await sql(`CHECKPOINT`);
          return slot();
        },
        { timeout: 60_000 },
      )
      .toBe('lost');
    await sql(`DROP TABLE wal_filler`);

    await link(1, 'up');
    await waitForMode(1, 'ONLINE', 480_000);
    expect(await slot()).not.toBe('lost');
    const [posts] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ForumPost" WHERE "discussionId" = $1 AND "contentHtml" LIKE $2`,
      [discussion!.id, `%${mark}%`],
    );
    expect(posts?.n).toBe(1);
    // the new copy follows the cloud again
    const later = `Из облака ${Date.now().toString(36)}`;
    await sql(
      `UPDATE "ForumPost" SET "contentHtml" = "contentHtml" || $2
        WHERE "discussionId" = $1 AND "contentHtml" LIKE $3`,
      [discussion!.id, `<p>${later}</p>`, `%${mark}%`],
    );
    await expect
      .poll(
        async () => {
          await page.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${discussion!.id}`);
          return page.getByText(later).count();
        },
        { timeout: 60_000 },
      )
      .toBe(1);
  } finally {
    await link(1, 'up');
    await sql(`DROP TABLE IF EXISTS wal_filler`);
  }
});
