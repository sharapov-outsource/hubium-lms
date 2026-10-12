import { type NextRequest, NextResponse } from 'next/server';

// Optimistic redirect only: real session checks happen in every page and action.
const PUBLIC = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/two-factor',
  '/verify-email',
  '/unsubscribe',
  '/api',
  '/_next',
  '/favicon',
  '/branding',
];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/' || PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const hasSession = req.cookies.getAll().some((c) => c.name.includes('hubium.session_token'));
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
