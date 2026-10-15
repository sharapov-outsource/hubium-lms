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
