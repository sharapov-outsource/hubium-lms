import { EMBED_HOSTS } from '@hubium/editor/server';

// Response security policy built per request (see architecture §Phase 8).
// Pages get a nonce-based CSP; API routes and the untrusted content origin (/c/) are
// excluded: they answer JSON/files or set their own sandboxing headers.

const origin = (url: string | undefined) => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export interface CspInput {
  nonce: string;
  dev: boolean;
  /** Origins of registered LTI tools (launched in iframes). */
  ltiOrigins: string[];
  env?: NodeJS.ProcessEnv;
}

export function buildCsp({ nonce, dev, ltiOrigins, env = process.env }: CspInput): string {
  const content = origin(env.CONTENT_HOST);
  const s3 = origin(env.S3_PUBLIC_URL ?? env.S3_ENDPOINT);
  const jitsi = env.JITSI_DOMAIN ? `https://${env.JITSI_DOMAIN}` : null;
  const bbb = origin(env.BBB_URL);
  const list = (...xs: (string | null | undefined)[]) =>
    [...new Set(xs.filter((x): x is string => !!x))].join(' ');
  const directives: Record<string, string> = {
    'default-src': "'self'",
    // strict-dynamic: scripts loaded by nonce'd scripts (Next chunks) are trusted
    'script-src': list(
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      dev ? "'unsafe-eval'" : null,
    ),
    'style-src': "'self' 'unsafe-inline'",
    'img-src': "'self' data: blob: https:",
    'font-src': "'self' data:",
    'media-src': list("'self'", 'blob:', s3),
    'connect-src': list("'self'", s3, dev ? 'ws:' : null),
    'worker-src': "'self' blob:",
    'frame-src': list(
      "'self'",
      content,
      ...EMBED_HOSTS.map((h) => `https://${h}`),
      ...ltiOrigins,
      jitsi,
      bbb,
    ),
    'form-action': list("'self'", ...ltiOrigins),
    'frame-ancestors': "'self'",
    'base-uri': "'self'",
    'object-src': "'none'",
    'manifest-src': "'self'",
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v}`);
  if (!dev && env.APP_URL?.startsWith('https://')) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

export function securityHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const h: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (env.NODE_ENV === 'production' && env.APP_URL?.startsWith('https://'))
    h['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  return h;
}

/** API paths that legitimately receive cross-site requests (tools, mail clients, bearer). */
const CROSS_SITE_OK = [
  '/api/v1/',
  '/api/auth/',
  '/api/unsubscribe/',
  '/api/mod/lti/',
  '/api/mod/livesession/',
  '/api/health',
];

/**
 * Cookie-authenticated route handlers must not be callable from other sites (CSRF).
 * Server actions are checked by Next itself; this covers our own API routes.
 */
export function isCrossSiteWrite(req: {
  method: string;
  pathname: string;
  headers: Headers;
  hasSession: boolean;
}): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  if (!req.pathname.startsWith('/api/') || !req.hasSession) return false;
  if (CROSS_SITE_OK.some((p) => req.pathname.startsWith(p))) return false;
  // "same-site" is not enough: the content origin (SCORM) is usually a sibling subdomain.
  const site = req.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  // Older browsers: fall back to Origin vs Host.
  const o = req.headers.get('origin');
  if (!o || o === 'null') return !!o;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(o).host !== host;
  } catch {
    return true;
  }
}

/**
 * The content origin serves only /c/ (untrusted packages). Anything else requested there
 * would put LMS pages on a host whose scripts are untrusted.
 */
export function isContentHostMisuse(
  req: { pathname: string; headers: Headers },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const content = origin(env.CONTENT_HOST);
  const app = origin(env.APP_URL);
  if (!content || content === app) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  return host === new URL(content).host && !req.pathname.startsWith('/c/');
}
