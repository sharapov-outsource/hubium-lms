import { buildInfo } from '@hubium/tooling/build-info';
import { defineConfig } from 'tsdown';

// One file like the worker: workspace packages and the third-party code they use are
// bundled, so the command needs no node_modules. Prisma's CLI, which applies migrations,
// ships beside it (see docker/Dockerfile).
export default defineConfig({
  entry: { hubium: 'src/bin.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  deps: { alwaysBundle: [/^@hubium\//], onlyBundle: false },
  env: buildInfo(),
});
