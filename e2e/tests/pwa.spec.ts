import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD, login } from './helpers';

// Installable PWA: manifest with icons, a service worker, and an offline fallback page.

test('manifest is installable-shaped', async ({ request }) => {
  const r = await request.get('/manifest.webmanifest');
  expect(r.status()).toBe(200);
  const m = await r.json();
  expect(m).toMatchObject({ display: 'standalone', start_url: '/dashboard' });
  const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
  expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  for (const i of m.icons)
    expect((await request.get(i.src)).headers()['content-type']).toBe('image/png');
});

test('service worker serves the offline page when the network is gone', async ({
  page,
  context,
}) => {
  await login(page, 'student1', DEMO_PASSWORD);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    /manifest\.webmanifest/,
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // the first visit installs it; the next navigation is controlled
  await page.goto('/calendar');
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // the fallback page is precached during install
  await expect.poll(() => page.evaluate(async () => !!(await caches.match('/offline')))).toBe(true);
  await context.setOffline(true);
  try {
    const heading = page.getByRole('heading', { name: 'Нет подключения к интернету' });
    await expect
      .poll(
        async () => {
          await page.goto('/my-courses').catch(() => {});
          return heading.count();
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    // the page came to life (its scripts were cached with it): back online, it loads the
    // page that was asked for by itself
    await context.setOffline(false);
    await expect(page.getByRole('heading', { name: 'Мои курсы', level: 1 })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
