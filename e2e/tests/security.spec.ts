import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, login } from './helpers';

// Security headers, CSP without violations on real pages, and CSRF protection of our
// cookie-authenticated route handlers.

test('pages send CSP and security headers', async ({ request }) => {
  const r = await request.get('/login');
  const h = r.headers();
  expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(h['content-security-policy']).toContain("frame-ancestors 'self'");
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['x-frame-options']).toBe('SAMEORIGIN');
});

test('no CSP violations across key pages', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (load|execute|frame|connect)/i.test(m.text()))
      violations.push(m.text());
  });
  const [c] = await sql<{ id: string; video: string; scorm: string | null; page: string }>(
    `SELECT c.id,
       (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'video' LIMIT 1) AS video,
       (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'scorm' AND "deletedAt" IS NULL LIMIT 1) AS scorm,
       (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'page' LIMIT 1) AS page
     FROM "Course" c WHERE c."shortName" = 'DEMO-PY'`,
  );
  await login(page, 'student1', DEMO_PASSWORD);
  const paths = [
    '/dashboard',
    `/course/${c!.id}`,
    `/course/${c!.id}/a/${c!.page}`,
    `/course/${c!.id}/a/${c!.video}`,
    `/course/${c!.id}/tutor`,
    '/messages',
    '/calendar',
    ...(c!.scorm ? [`/course/${c!.id}/a/${c!.scorm}`] : []),
  ];
  for (const p of paths) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
  }
  // the theme switch and client navigation still work under the policy
  await page.goto('/settings/preferences');
  await expect(page.locator('html')).toHaveAttribute('class', /light|dark/);
  expect(violations).toEqual([]);
});

test('cross-site POSTs with the session cookie are rejected', async ({ page }) => {
  await login(page, 'student1', DEMO_PASSWORD);
  const res = await page.request.post('/api/messages/typing', {
    headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
    data: { conversationId: '00000000-0000-7000-8000-000000000000' },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
  // same-origin requests are unaffected
  const ok = await page.request.post('/api/messages/typing', {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
    data: { conversationId: '00000000-0000-7000-8000-000000000000' },
  });
  expect(ok.status()).not.toBe(403);
});
