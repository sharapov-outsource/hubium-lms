import { sign, verifySignature } from './crypto.ts';
import { getEnv } from './env.ts';

// Untrusted content (SCORM packages, raw HTML) is served from a separate origin
// (CONTENT_HOST) under /c/<token>/…, so it can never read the LMS session cookie.
// The token in the path authorises the request and keeps relative URLs working.

export interface ContentGrant {
  /** Activity id (its module answers the request). */
  a: string;
  /** User the content runs for. */
  u: string;
  /** Module-specific data (attempt, SCO…). */
  d?: Record<string, string | number>;
  /** Expiry, unix seconds. */
  e: number;
}

const PURPOSE = 'content';

export function contentOrigin(env = process.env): string {
  return (env.CONTENT_HOST || env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export function signContentToken(grant: Omit<ContentGrant, 'e'>, ttlSec = 8 * 3600): string {
  const payload: ContentGrant = { ...grant, e: Math.floor(Date.now() / 1000) + ttlSec };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data, getEnv().APP_SECRET, PURPOSE)}`;
}

export function verifyContentToken(token: string): ContentGrant | null {
  const [data, sig] = token.split('.');
  if (!data || !sig || !verifySignature(data, sig, getEnv().APP_SECRET, PURPOSE)) return null;
  try {
    const g = JSON.parse(Buffer.from(data, 'base64url').toString()) as ContentGrant;
    return g.e > Date.now() / 1000 ? g : null;
  } catch {
    return null;
  }
}

export function contentUrl(grant: Omit<ContentGrant, 'e'>, path: string, ttlSec?: number): string {
  return `${contentOrigin()}/c/${signContentToken(grant, ttlSec)}/${path.replace(/^\/+/, '')}`;
}
