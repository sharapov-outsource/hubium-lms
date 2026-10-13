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
  // The SCORM runtime host reads scorm-again's browser bundles from disk.
  outputFileTracingIncludes: {
    '/c/**': ['../../node_modules/.pnpm/scorm-again@*/node_modules/scorm-again/dist/scorm*.min.js'],
  },
  typedRoutes: false,
  poweredByHeader: false,
  // Render <title> and meta tags in <head> up front instead of streaming them into <body>:
  // screen readers announce the title on load, and site settings are cached, so it is cheap.
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      {
        // The service worker must always be revalidated and may only load same-origin code.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  experimental: {
    serverActions: { bodySizeLimit: '10mb' },
    authInterrupts: true,
  },
};

export default withNextIntl(config);
