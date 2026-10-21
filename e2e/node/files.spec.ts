import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { sql } from '../tests/db';
import { ADMIN, DEMO_PASSWORD, login, logout } from '../tests/helpers';
import { demoCourse, waitForMode } from './helpers';
import { link, nodeState, nodeUrl, WORK } from './stack';

// Files through the node: the cloud's files are on the node before the line goes down, and
// the node serves them whole and in ranges (video seeks) without the cloud. A file handed
// in on the node while the line is down reaches the cloud's storage with the sync.

test.use({ baseURL: nodeUrl(1) });

test('the node serves the cloud’s files without a connection and sends up new ones', async ({
  page,
}) => {
  const ids = await demoCourse();
  const [file] = await sql<{ id: string; name: string; size: number }>(
    `SELECT f.id, f.name, b.size::int AS size FROM "File" f JOIN "FileBlob" b ON b.id = f."blobId"
      WHERE f.name = 'cherry-orchard.zip' LIMIT 1`,
  );
  await waitForMode(1, 'ONLINE');
  // the mirror has the cloud's files
  await expect
    .poll(
      async () => {
        const f = (await nodeState(1)).files as { done: number; total: number } | null;
        return !!f && f.total > 0 && f.done === f.total;
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  await login(page, ADMIN.login, ADMIN.password);
  const url = `/files/${file!.id}/${encodeURIComponent(file!.name)}`;
  const online = await (await page.request.get(url)).body();
  expect(online.length).toBe(file!.size);

  await link(1, 'refuse');
  await waitForMode(1, 'OFFLINE');
  const whole = await page.request.get(url);
  expect(whole.status()).toBe(200);
  expect(Buffer.compare(await whole.body(), online)).toBe(0);
  const part = await page.request.get(url, { headers: { range: 'bytes=10-19' } });
  expect(part.status()).toBe(206);
  expect(part.headers()['content-range']).toBe(`bytes 10-19/${file!.size}`);
  expect(Buffer.compare(await part.body(), online.subarray(10, 20))).toBe(0);

  // a student hands in a file on the node
  await logout(page);
  await login(page, 'student1', DEMO_PASSWORD);
  await page.goto(`/course/${ids.courseId}/a/${ids.assignId}`);
  const name = `offline-${Date.now().toString(36)}.txt`;
  await page.locator('#assign-files').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from('Сделано в аудитории без связи'),
  });
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('link', { name })).toBeVisible();

  await link(1, 'up');
  await waitForMode(1, 'ONLINE', 180_000);
  const [sent] = await sql<{ key: string }>(
    `SELECT b."storageKey" AS key FROM "File" f JOIN "FileBlob" b ON b.id = f."blobId"
      WHERE f.name = $1`,
    [name],
  );
  expect(sent?.key).toBeTruthy();
  expect(existsSync(path.join(WORK, 'cloud-storage', sent!.key))).toBe(true);
  // and the student downloads it from the cloud's data through the node
  await page.goto(`/course/${ids.courseId}/a/${ids.assignId}`);
  const link2 = page.getByRole('link', { name });
  const href = await link2.getAttribute('href');
  const down = await page.request.get(href!);
  expect(await down.text()).toBe('Сделано в аудитории без связи');
});
