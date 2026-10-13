import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, expectAccessible, login } from './helpers';

// An administrator subscribes a receiver run by this test; the worker delivers signed
// events to it. The app must allow the loopback host: SSRF_ALLOW_HOSTS=127.0.0.1.

const allowed = (process.env.SSRF_ALLOW_HOSTS ?? '').split(',').includes('127.0.0.1');

test.describe
  .serial('webhooks', () => {
    test.skip(!allowed, 'needs SSRF_ALLOW_HOSTS=127.0.0.1 for the app and the worker');

    const received: { headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    let url = '';
    let webhookId = '';

    test.beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    });
    test.afterAll(async () => {
      if (webhookId) await sql(`DELETE FROM "Webhook" WHERE id = $1`, [webhookId]);
      await new Promise((r) => server.close(r));
    });

    const signed = (r: (typeof received)[number], secret: string) => {
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(r.headers['x-hubium-signature']))!;
      return createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex') === v1;
    };
    const event = (type: string) => received.find((r) => JSON.parse(r.body).type === type) ?? null;

    test('an administrator subscribes a receiver and gets signed events', async ({ page }) => {
      await login(page, ADMIN.login, ADMIN.password);
      await page.goto('/admin/webhooks');
      await expect(page).toHaveTitle(/^Вебхуки · Администрирование/);
      await page.locator('#f-name').fill('E2E receiver');
      await page.locator('#f-url').fill(url);
      await page.getByLabel(/Курс изменён/).check();
      await page.getByRole('button', { name: 'Создать вебхук' }).click();
      const secret = (await page.getByTestId('webhook-secret').innerText()).trim();
      expect(secret).toMatch(/^whsec_/);
      await expectAccessible(page);

      await page.getByRole('link', { name: 'E2E receiver' }).click();
      await page.waitForURL(/\/admin\/webhooks\/[0-9a-f-]{36}$/);
      webhookId = page.url().split('/').pop()!;
      await page.getByRole('button', { name: 'Отправить проверку' }).click();
      await expect.poll(() => event('ping'), { timeout: 30_000 }).not.toBeNull();
      expect(signed(event('ping')!, secret)).toBe(true);

      // Saving the demo course (unchanged) is a "course.updated" event.
      const [course] = await sql<{ id: string }>(
        `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`,
      );
      await page.goto(`/course/${course!.id}/settings`);
      await page.getByRole('button', { name: 'Сохранить', exact: true }).first().click();
      await expect(page.getByText('Настройки курса сохранены').first()).toBeVisible();
      await expect.poll(() => event('course.updated'), { timeout: 30_000 }).not.toBeNull();
      const update = event('course.updated')!;
      expect(signed(update, secret)).toBe(true);
      expect(update.headers['x-hubium-event']).toBe('course.updated');
      expect(JSON.parse(update.body).data.course).toMatchObject({
        id: course!.id,
        shortName: 'DEMO-PY',
      });

      await page.goto(`/admin/webhooks/${webhookId}`);
      await expect(page.getByText('Доставлено')).toHaveCount(2);
      await expectAccessible(page);

      await page.getByRole('button', { name: 'Удалить' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
      await page.waitForURL(/\/admin\/webhooks$/);
      await expect(page.getByRole('link', { name: 'E2E receiver' })).toHaveCount(0);
      webhookId = '';
    });
  });
