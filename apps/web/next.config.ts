import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const root = path.resolve(import.meta.dirname, '../..');

/**
 * Build identity shown in the sidebar and on the environment page, fixed at build time: the
 * version from the root manifest, the commit from BUILD_COMMIT (Docker and CI builds have no
 * .git) or the checkout, and the build time.
 */
function buildInfo() {
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  let commit = process.env.BUILD_COMMIT?.trim() ?? '';
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Not a git checkout: the version alone identifies the build.
    }
  }
  return {
    HUBIUM_VERSION: version,
    HUBIUM_COMMIT: commit.slice(0, 7),
    HUBIUM_BUILT_AT: new Date().toISOString(),
  };
}

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  env: buildInfo(),
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
  // The SCORM runtime host and the API reference read browser bundles from disk.
  outputFileTracingIncludes: {
    '/c/**': ['../../node_modules/.pnpm/scorm-again@*/node_modules/scorm-again/dist/scorm*.min.js'],
    '/api/v1/**': [
      '../../node_modules/.pnpm/@scalar+api-reference@*/node_modules/@scalar/api-reference/dist/browser/standalone.js',
    ],
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
