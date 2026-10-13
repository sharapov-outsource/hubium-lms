import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env on its own. The monorepo keeps one .env at the root.
loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Read lazily rather than with env(): `prisma generate` needs no database (Docker
    // builds have none), while migrate commands fail with a clear error when it is unset.
    url: process.env.DATABASE_URL ?? '',
  },
});
