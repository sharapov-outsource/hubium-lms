import { describe, expect, it } from 'vitest';
import { buildCsp, isContentHostMisuse, isCrossSiteWrite, securityHeaders } from './security';

const env = {
  NODE_ENV: 'production',
  APP_URL: 'https://lms.example.org',
  CONTENT_HOST: 'https://content.example.org',
  S3_PUBLIC_URL: 'https://s3.example.org/hubium',
  JITSI_DOMAIN: 'meet.example.org',
} as NodeJS.ProcessEnv;

const directive = (csp: string, name: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1)
    .split(' ') ?? [];

describe('CSP', () => {
  it('uses a nonce with strict-dynamic and no unsafe script sources in production', () => {
    const csp = buildCsp({ nonce: 'abc', dev: false, ltiOrigins: ['https://tool.test'], env });
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'self'"]);
    expect(directive(csp, 'frame-src')).toEqual(
      expect.arrayContaining([
        'https://content.example.org',
        'https://www.youtube-nocookie.com',
        'https://rutube.ru',
        'https://tool.test',
        'https://meet.example.org',
      ]),
    );
    expect(directive(csp, 'media-src')).toContain('https://s3.example.org');
    expect(directive(csp, 'form-action')).toEqual(["'self'", 'https://tool.test']);
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('allows eval and websockets only in development', () => {
    const csp = buildCsp({ nonce: 'n', dev: true, ltiOrigins: [], env: {} as NodeJS.ProcessEnv });
    expect(directive(csp, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(csp, 'connect-src')).toContain('ws:');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('sends HSTS only for HTTPS production', () => {
    expect(securityHeaders(env)['Strict-Transport-Security']).toMatch(/max-age=\d+/);
    expect(securityHeaders({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toHaveProperty(
      'Strict-Transport-Security',
    );
  });
});

describe('cross-site write check', () => {
  const req = (
    over: Partial<Parameters<typeof isCrossSiteWrite>[0]>,
    h: Record<string, string> = {},
  ) =>
    isCrossSiteWrite({
      method: 'POST',
      pathname: '/api/mod/action',
      hasSession: true,
      headers: new Headers({ host: 'lms.example.org', ...h }),
      ...over,
    });

  it('blocks cross-site cookie writes to our route handlers', () => {
    expect(req({}, { 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(req({}, { origin: 'https://evil.example' })).toBe(true);
    expect(req({}, { origin: 'null' })).toBe(true);
    // the content origin is a sibling subdomain: same-site, but untrusted
    expect(req({}, { 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(req({}, { origin: 'https://content.example.org' })).toBe(true);
  });

  it('lets through same-origin, reads, anonymous and allowlisted callers', () => {
    expect(req({}, { 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(req({}, { origin: 'https://lms.example.org' })).toBe(false);
    expect(req({}, {})).toBe(false); // server-to-server, no browser headers
    expect(req({ method: 'GET' }, { 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(req({ hasSession: false }, { 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(req({ pathname: '/api/mod/lti/token' }, { 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(req({ pathname: '/api/v1/me' }, { 'sec-fetch-site': 'cross-site' })).toBe(false);
  });
});

describe('content origin', () => {
  const env = {
    APP_URL: 'https://lms.example.org',
    CONTENT_HOST: 'https://content.example.org',
  } as unknown as NodeJS.ProcessEnv;
  const misuse = (host: string, pathname: string, e = env) =>
    isContentHostMisuse({ pathname, headers: new Headers({ host }) }, e);

  it('serves only /c/ on the content host', () => {
    expect(misuse('content.example.org', '/dashboard')).toBe(true);
    expect(misuse('content.example.org', '/api/mod/action')).toBe(true);
    expect(misuse('content.example.org', '/c/token/pkg/index.html')).toBe(false);
    expect(misuse('lms.example.org', '/dashboard')).toBe(false);
    // without a separate content domain there is nothing to protect
    expect(
      misuse('lms.example.org', '/dashboard', { APP_URL: 'https://lms.example.org' } as never),
    ).toBe(false);
  });
});
