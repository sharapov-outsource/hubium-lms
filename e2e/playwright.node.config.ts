import { defineConfig, devices } from '@playwright/test';
import { CLOUD } from './node/stack';

// The local node scenarios (e2e/node): the cloud and two nodes on this machine, with links
// the scenarios cut (node/stack.ts). The stack comes up before them unless NODE_STACK=running
// says it is up already (node e2e/node/stack.ts up).
process.env.DATABASE_URL = CLOUD.db;

const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './node',
  testMatch: /\.spec\.ts$/,
  // outages take their time: the node waits before it works alone, and syncs after
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './node/global-setup.ts',
  globalTeardown: './node/global-teardown.ts',
  use: {
    locale: 'ru-RU',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: executablePath ? { executablePath } : {},
  },
});
