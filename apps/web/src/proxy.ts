import { type NextRequest, NextResponse } from 'next/server';
import { ltiOrigins } from './server/lti-origins';
import { buildCsp, isCrossSiteWrite, securityHeaders } from './server/security';

// Optimistic redirect only: real session checks happen in every page and action.
const PUBLIC = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/two-factor',
  '/verify-email',
  '/unsubscribe',
  '/offline',
  '/c/',
  '/api',
  '/_next',
  '/favicon',
  '/branding',
  '/manifest.webmanifest',
  '/sw.js',
  '/icons/',
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Untrusted content origin: its route sets its own sandboxing headers.
  if (pathname.startsWith('/c/')) return NextResponse.next();
  const hasSession = req.cookies.getAll().some((c) => c.name.includes('hubium.session_token'));

  if (isCrossSiteWrite({ method: req.method, pathname, headers: req.headers, hasSession }))
    return NextResponse.json(
      { ok: false, code: 'FORBIDDEN', message: 'Cross-site request blocked' },
      { status: 403 },
    );

  // Files (sw.js, manifest, icons) keep their own headers; pages get the nonce CSP.
  const isPage =
    !pathname.startsWith('/api') && !pathname.startsWith('/_next') && !/\.[a-z0-9]+$/i.test(pathname);
  let res: NextResponse;
  if (!isPage) {
    res = NextResponse.next();
  } else if (pathname !== '/' && !PUBLIC.some((p) => pathname.startsWith(p)) && !hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
    res = NextResponse.redirect(url);
  } else {
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
    const csp = buildCsp({
      nonce,
      dev: process.env.NODE_ENV !== 'production',
      ltiOrigins: await ltiOrigins(),
    });
    // Next reads the nonce from the request CSP header and applies it to its scripts.
    const headers = new Headers(req.headers);
    headers.set('x-nonce', nonce);
    headers.set('content-security-policy', csp);
    res = NextResponse.next({ request: { headers } });
    res.headers.set('Content-Security-Policy', csp);
  }
  for (const [k, v] of Object.entries(securityHeaders())) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
