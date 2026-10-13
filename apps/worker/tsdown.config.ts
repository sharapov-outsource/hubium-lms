import { defineConfig } from 'tsdown';

// Bundles workspace packages (source-only) into one file. Third-party code reached through
// them is bundled too, because the worker's package.json lists only workspace packages.
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  deps: { alwaysBundle: [/^@hubium\//], onlyBundle: false },
});
