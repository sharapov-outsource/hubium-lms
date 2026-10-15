import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, expectNoSideScroll, login } from './helpers';

// An .ics file imported into a personal calendar and a feed subscribed by its address
// (served here on the loopback, which SSRF_ALLOW_HOSTS lets the server reach), seen in
// the day view.

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const stamp = (n: number) => `${day(n).replace(/-/g, '')}T100000Z`;
const ics = (events: string[]) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('')}END:VCALENDAR\r\n`;
const ev = (uid: string, n: number, summary: string, extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${stamp(n)}\r\nDTEND:${stamp(n).replace('T10', 'T11')}\r\nSUMMARY:${summary}\r\n${extra}END:VEVENT\r\n`;

test('calendar: a file imported, a feed subscribed, a day at a glance', async ({ page }) => {
  let feed = ics([ev('o1', 2, 'Олимпиада')]);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(feed);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const [me] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = 'student3'`);
  try {
    await login(page, 'student3', DEMO_PASSWORD);
    await page.goto('/calendar');
    const imports = page.getByRole('list', { name: 'Импорт и подписки' });

    // a weekly training from a file, into my own calendar
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'ics-')), 'section.ics');
    writeFileSync(
      file,
      ics([ev('t1', 1, 'Тренировка', 'RRULE:FREQ=WEEKLY;COUNT=2\r\nLOCATION:Зал 2\r\n')]),
    );
    await page.locator('#imp-name').fill('Секция');
    await page.locator('#imp-file').setInputFiles(file);
    await page.getByRole('button', { name: 'Импортировать' }).click();
    await expect(page.getByText('Загружено 2 события').first()).toBeVisible();
    await expect(imports.getByText('Секция')).toBeVisible();

    // a feed by its address
    await page.getByLabel('Подписка по адресу').check();
    await page.locator('#imp-name').fill('Олимпиады');
    await page.locator('#imp-url').fill(`http://127.0.0.1:${port}/feed.ics`);
    await page.getByRole('button', { name: 'Подписаться' }).click();
    await expect(page.getByText('Загружено 1 событие').first()).toBeVisible();
    await expect(imports.getByText('Олимпиады')).toBeVisible();
    await expectAccessible(page);

    // the day view, and the next day
    await page.goto(`/calendar?view=day&d=${day(1)}`);
    await expect(page.getByText('Тренировка')).toBeVisible();
    await expect(page.getByText(/Событие · Зал 2/)).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('link', { name: 'Следующий день' }).click();
    await expect(page.getByText('Олимпиада')).toBeVisible();

    // the feed changes and is refreshed
    feed = ics([ev('o1', 2, 'Олимпиада'), ev('o2', 3, 'Финал олимпиады')]);
    await page.goto('/calendar');
    const sub = imports.getByRole('listitem').filter({ hasText: 'Олимпиады' });
    await sub.getByRole('button', { name: 'Обновить' }).click();
    await expect(sub.getByText(/2 события/)).toBeVisible();

    // an import goes with its events
    const section = imports.getByRole('listitem').filter({ hasText: 'Секция' });
    await section.getByRole('button', { name: 'Удалить' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
    await expect(imports.getByText('Секция')).toHaveCount(0);
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, `/calendar?view=day&d=${day(1)}`);
  } finally {
    server.close();
    await sql(`DELETE FROM "CalendarSubscription" WHERE "userId" = $1`, [me!.id]);
  }
});

test('an all-day event keeps its date west of UTC', async ({ page }) => {
  const [u] = await sql<{ id: string }>(
    `UPDATE "User" SET timezone = 'America/New_York' WHERE username = 'student2' RETURNING id`,
  );
  const title = `Праздник ${Date.now()}`;
  await sql(
    `INSERT INTO "CalendarEvent" (id, scope, "userId", title, "startsAt", "allDay", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), 'USER', $1, $2, '2026-10-15T00:00:00Z', true, now(), now())`,
    [u!.id, title],
  );
  try {
    await login(page, 'student2', DEMO_PASSWORD);
    // a date, not the evening of the day before in New York
    await page.goto('/calendar?view=day&date=2026-10-15');
    await expect(page.getByText(title)).toBeVisible();
    await page.goto('/calendar?view=day&date=2026-10-14');
    await expect(page.getByText(title)).toHaveCount(0);
  } finally {
    await sql(`DELETE FROM "CalendarEvent" WHERE title = $1`, [title]);
    await sql(`UPDATE "User" SET timezone = NULL WHERE id = $1`, [u!.id]);
  }
});

test('the subscription link is shown once, and a new one is asked for first', async ({ page }) => {
  const [u] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = 'student3'`);
  await sql(`DELETE FROM "CalendarFeedToken" WHERE "userId" = $1`, [u!.id]);
  try {
    await login(page, 'student3', DEMO_PASSWORD);
    await page.goto('/calendar');
    const link = page.getByLabel('Подписка в календаре');
    await page.getByRole('button', { name: 'Получить ссылку' }).click();
    const first = await link.inputValue();
    expect((await page.request.get(first)).ok()).toBe(true);

    await page.reload();
    await expect(page.getByText(/^Ссылка выдана /)).toBeVisible();
    await page.getByRole('button', { name: 'Получить новую ссылку' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/перестанут обновляться/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(link).not.toHaveValue(first);
    expect((await page.request.get(await link.inputValue())).ok()).toBe(true);
    // the old link no longer opens the calendar
    expect((await page.request.get(first)).ok()).toBe(false);
  } finally {
    await sql(`DELETE FROM "CalendarFeedToken" WHERE "userId" = $1`, [u!.id]);
  }
});
