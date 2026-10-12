import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// SSRF guard for server-side requests to admin- or user-supplied URLs (LTI JWKS, AI
// endpoints, webhooks). Hosts resolving to loopback, private, link-local or otherwise
// internal addresses are refused unless listed in SSRF_ALLOW_HOSTS (comma-separated host
// names, e.g. "ollama,bbb.internal"), so a self-hosted model on the LAN stays possible.

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function allowHosts(): Set<string> {
  return new Set(
    (process.env.SSRF_ALLOW_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isInternalAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true;
}

/**
 * Cheap save-time check without DNS: http(s), no credentials, and not an internal IP
 * literal or localhost (unless allowlisted). Requests still go through `safeFetch`.
 */
export function checkUrlShape(url: string | URL): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new UnsafeUrlError('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new UnsafeUrlError('Credentials in URLs are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowHosts().has(host)) return u;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (isIP(host) && isInternalAddress(host))
  )
    throw new UnsafeUrlError(
      `${host} is an internal address; add it to SSRF_ALLOW_HOSTS to allow it`,
    );
  return u;
}

/** Throws UnsafeUrlError unless `url` is http(s) and resolves only to public addresses. */
export async function assertPublicUrl(url: string | URL): Promise<URL> {
  const u = checkUrlShape(url);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowHosts().has(host)) return u;
  const addrs = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new UnsafeUrlError(`Cannot resolve ${host}`);
      });
  if (!addrs.length || addrs.some((a) => isInternalAddress(a.address)))
    throw new UnsafeUrlError(
      `${host} resolves to an internal address; add it to SSRF_ALLOW_HOSTS to allow it`,
    );
  return u;
}

/**
 * fetch() that checks the target and every redirect hop. Redirects are followed manually
 * (at most 5) so a public URL cannot bounce the request to an internal one.
 */
export async function safeFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : input);
  const base =
    input instanceof Request
      ? { method: input.method, headers: input.headers, body: input.body }
      : {};
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { ...base, ...init, redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc) return res;
    url = new URL(loc, url);
  }
  throw new UnsafeUrlError('Too many redirects');
}
