import { defineConfig } from 'tsdown';

// Bundles workspace packages (source-only) into one file; npm deps stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  noExternal: [/^@hubium\//],
});
