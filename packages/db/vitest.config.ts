import { defineConfig } from 'vitest/config';

// The database tests create and migrate databases; when every package's suite runs at once,
// that takes longer than vitest's default 10 seconds.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
