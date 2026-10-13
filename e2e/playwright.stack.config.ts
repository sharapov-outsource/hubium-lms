import { defineConfig, devices } from '@playwright/test';

// Checks against the production stack (docker/compose.yml behind Caddy, seeded with
// SEED_PROFILE=demo): `pnpm --filter @hubium/e2e stack`. Google Chrome instead of
// Playwright's Chromium, because it decodes H.264 and the video really plays.
export default defineConfig({
  testDir: './stack',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: process.env.STACK_URL ?? 'https://lms.localhost',
    // Caddy issues *.localhost certificates from its own local CA
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
