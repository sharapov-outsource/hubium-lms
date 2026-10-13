import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  // only the sources: `next build` copies files into .next/standalone
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
