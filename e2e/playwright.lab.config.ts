import { defineConfig, devices } from '@playwright/test';
import { resolveTo } from './lab/helpers';
import { branchIp, LMS } from './lab/lab';

// The lab of a cloud and branch servers installed as in production (e2e/lab). It is built
// and set up before the scenarios unless LAB=running says it is up already (node
// e2e/lab/lab.ts build && node e2e/lab/lab.ts up); LAB_KEEP=1 leaves it up afterwards.
// The browser is in branch 1's network: its DNS sends the LMS's names to the node there.

const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './lab',
  testMatch: /\.spec\.ts$/,
  // installations and outages take minutes
  timeout: 900_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalSetup: './lab/global-setup.ts',
  globalTeardown: './lab/global-teardown.ts',
  use: {
    baseURL: LMS,
    // the cloud's own authority signs its certificates (Caddy local_certs)
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: { executablePath, args: resolveTo(branchIp(1)) },
  },
  projects: [
    { name: 'install', testMatch: /00-install\.spec\.ts$/ },
    { name: 'scenarios', testIgnore: /00-install\.spec\.ts$/, dependencies: ['install'] },
  ],
});
