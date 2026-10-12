import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(import.meta.dirname, '../..'),
  transpilePackages: [
    '@hubium/core',
    '@hubium/db',
    '@hubium/editor',
    '@hubium/i18n',
    '@hubium/module-sdk',
    '@hubium/ui',
    '@hubium/mod-content',
  ],
  serverExternalPackages: ['pg', 'pg-boss', '@prisma/client', '@prisma/adapter-pg', 'nodemailer'],
  typedRoutes: false,
  poweredByHeader: false,
  experimental: {
    serverActions: { bodySizeLimit: '10mb' },
    authInterrupts: true,
  },
};

export default withNextIntl(config);
