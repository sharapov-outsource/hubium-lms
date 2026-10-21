import { expect, test } from '@playwright/test';
import { sql } from '../tests/db';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import { demoCourse, waitForMode } from './helpers';
import { link, nodeUrl } from './stack';

// Signing in and writing on the forum while the line to the cloud is down: two students sign
// in on the node, one starts a discussion and the other answers. Once the line is back the
// discussion is in the cloud with the ids the node gave it, and both stay signed in.

test.use({ baseURL: nodeUrl(1) });

test('signing in and forum posts without a connection reach the cloud', async ({ browser }) => {
  const ids = await demoCourse();
  await waitForMode(1, 'ONLINE');
  await link(1, 'refuse');
  await waitForMode(1, 'OFFLINE');

  const a = await browser.newContext();
  const b = await browser.newContext();
  const author = await a.newPage();
  const replier = await b.newPage();
  // the sessions are made on the node: the cloud cannot be asked
  await login(author, 'student1', DEMO_PASSWORD);
  await login(replier, 'student2', DEMO_PASSWORD);

  await author.goto(`/course/${ids.courseId}/a/${ids.forumId}`);
  await expect(author.locator('[data-node-mode="OFFLINE"]')).toBeVisible();
  const title = `Без связи ${Date.now().toString(36)}`;
  await author.getByRole('button', { name: 'Новая тема' }).click();
  await author.locator('#fd-title').fill(title);
  await author.locator('#fd-message').click();
  await author.keyboard.type('Почему в аудитории нет интернета?');
  await author.getByRole('button', { name: 'Отправить' }).click();
  await author.waitForURL(/\?d=/);
  const discussionId = new URL(author.url()).searchParams.get('d')!;
  await expect(author.getByRole('heading', { name: title })).toBeVisible();

  await replier.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${discussionId}`);
  await replier.getByRole('button', { name: 'Ответить' }).first().click();
  await replier.locator('[id^="msg-"]').first().click();
  await replier.keyboard.type('Зато узел работает');
  await replier.getByRole('button', { name: 'Отправить' }).click();
  await expect(replier.getByText('Зато узел работает')).toBeVisible();

  // the cloud has none of it yet
  const [before] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM "ForumDiscussion" WHERE id = $1`,
    [discussionId],
  );
  expect(before?.n).toBe(0);

  await link(1, 'up');
  await waitForMode(1, 'ONLINE', 180_000);
  const posts = await sql<{ username: string; text: string }>(
    `SELECT u.username, p."contentHtml" AS text FROM "ForumPost" p
       JOIN "User" u ON u.id = p."authorId"
      WHERE p."discussionId" = $1 ORDER BY p."createdAt"`,
    [discussionId],
  );
  expect(posts.map((p) => p.username)).toEqual(['student1', 'student2']);
  expect(posts[1]?.text).toContain('Зато узел работает');

  // still signed in, now reading the cloud's data through the node
  await author.reload();
  await expect(author.getByText('Зато узел работает')).toBeVisible();
  await expect(author.locator('[data-node-mode]')).toHaveCount(0);
  await replier.goto('/dashboard');
  await expect(replier).toHaveURL(/\/dashboard/);
  await a.close();
  await b.close();
});
