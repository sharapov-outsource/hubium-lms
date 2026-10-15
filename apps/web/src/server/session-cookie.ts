import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The session token in a request's Better Auth cookie ("<token>.<HMAC-SHA256 of the token,
 * base64>"), or null unless the signature holds: for proxy.ts, which looks sessions up
 * before Better Auth sees the request.
 */
export function sessionToken(
  cookies: { name: string; value: string }[],
  secret = process.env.APP_SECRET ?? '',
): string | null {
  const cookie = cookies.find((c) => c.name.endsWith('hubium.session_token'));
  if (!cookie || !secret) return null;
  const value = decodeURIComponent(cookie.value);
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const token = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(token).digest('base64'));
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
}
