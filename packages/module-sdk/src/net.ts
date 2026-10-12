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
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (wraps an IPv4 address)
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** The 8 16-bit groups of an IPv6 address (handles "::" and a dotted IPv4 tail). */
function ipv6Groups(ip: string): number[] {
  let s = ip.toLowerCase().split('%')[0]!;
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => Number.parseInt(g || '0', 16));
}

/** IPv4 address carried inside an IPv6 one (mapped, NAT64 or 6to4), if any. */
function embeddedIPv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // ::ffff:a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  // 64:ff9b::a.b.c.d (NAT64) and 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4(g[6]!, g[7]!);
  // 2002:aabb:ccdd::/48 (6to4)
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

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
    const inner = embeddedIPv4(ip);
    if (inner) return blocked.check(inner, 'ipv4');
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
  const req = input instanceof Request ? input : null;
  let method = (init.method ?? req?.method ?? 'GET').toUpperCase();
  let body = init.body ?? req?.body ?? null;
  const headers = new Headers(init.headers ?? req?.headers);
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { ...init, method, body, headers, redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc) return res;
    const next = new URL(loc, url);
    // Like browsers: API keys never follow a redirect to another origin…
    if (next.origin !== url.origin)
      for (const h of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key'])
        headers.delete(h);
    // …and 303 (or 301/302 after POST) continues as a GET without the body.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = null;
      headers.delete('content-type');
    }
    url = next;
  }
  throw new UnsafeUrlError('Too many redirects');
}
