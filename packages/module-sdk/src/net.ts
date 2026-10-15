import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';
import { type Msg, msg } from './msg.ts';

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

/** An address server-side requests may not reach; `msg` says why, for people. */
export class UnsafeUrlError extends Error {
  constructor(readonly msg: Msg) {
    super(String(msg));
    this.name = 'UnsafeUrlError';
  }
}

/** Why an address was refused, for people: an UnsafeUrlError's message, else "Invalid URL". */
export function urlRefusal(e: unknown): Msg {
  return e instanceof UnsafeUrlError ? e.msg : msg('errors.url.invalid');
}

/** Hosts SSRF_ALLOW_HOSTS lets server-side requests reach although they are internal. */
export function ssrfAllowedHosts(): Set<string> {
  return allowHosts();
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
    throw new UnsafeUrlError(msg('errors.url.invalid'));
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new UnsafeUrlError(msg('errors.url.scheme'));
  if (u.username || u.password) throw new UnsafeUrlError(msg('errors.url.credentials'));
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowHosts().has(host)) return u;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (isIP(host) && isInternalAddress(host))
  )
    throw new UnsafeUrlError(msg('errors.url.internal', { host }));
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
        throw new UnsafeUrlError(msg('errors.url.unresolvable', { host }));
      });
  if (!addrs.length || addrs.some((a) => isInternalAddress(a.address)))
    throw new UnsafeUrlError(msg('errors.url.resolvesInternal', { host }));
  return u;
}

/**
 * dns.lookup for outgoing connections that refuses internal addresses as the connection is
 * made. Checking the URL first is not enough: a name can answer a public address then and an
 * internal one a moment later (DNS rebinding, TTL 0).
 */
export function publicLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!list.length || (!allowHosts().has(host) && list.some((a) => isInternalAddress(a.address))))
      return callback(
        new UnsafeUrlError(
          msg('errors.url.resolvesInternal', { host }),
        ) as unknown as NodeJS.ErrnoException,
        [],
      );
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

let agent: Agent | undefined;
/** The dispatcher of outgoing requests: connections reach public addresses only. */
export function publicAgent(): Agent {
  agent ??= new Agent({ connect: { lookup: publicLookup as never } });
  return agent;
}

let httpsAgent: HttpsAgent | undefined;
/** For node:https clients (web push): connections reach public addresses only. */
export function publicHttpsAgent(): HttpsAgent {
  httpsAgent ??= new HttpsAgent({ lookup: publicLookup as never, keepAlive: true });
  return httpsAgent;
}

/** fetch() whose connections reach public addresses only, whatever the name says by then. */
export async function publicFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, dispatcher: publicAgent() } as unknown as RequestInit);
  } catch (e) {
    // fetch reports "fetch failed": say why when it was the guard
    const cause = (e as { cause?: unknown }).cause;
    throw cause instanceof UnsafeUrlError ? cause : e;
  }
}

/**
 * fetch() that checks the target and every redirect hop, and the address of every
 * connection (publicFetch). Redirects are followed manually (at most 5) so a public URL
 * cannot bounce the request to an internal one.
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
    const res = await publicFetch(url, { ...init, method, body, headers, redirect: 'manual' });
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
  throw new UnsafeUrlError(msg('errors.url.redirects'));
}

// ── address lists ─────────────────────────────────────────────────────────────
// "Require network address" (a quiz may be taken only from these addresses), written as
// Moodle's subnet setting: comma- or space-separated entries, each a full address, a CIDR
// block (192.168.0.0/16, 2001:db8::/32), a last-octet range (192.168.1.10-20) or a partial
// address matched by whole parts (10.1, 2001:db8).

type Matcher = (ip: string, family: 4 | 6) => boolean;

/** The address without brackets or zone, and an IPv4-mapped IPv6 address as plain IPv4. */
function plainIp(raw: string): { ip: string; family: 4 | 6 } | null {
  const s = raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!;
  const v = isIP(s);
  if (v === 4) return { ip: s, family: 4 };
  if (v !== 6) return null;
  const g = ipv6Groups(s);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return { ip: `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`, family: 4 };
  return { ip: s.toLowerCase(), family: 6 };
}

function matcher(entry: string): Matcher | null {
  const list = new BlockList();
  try {
    const cidr = entry.match(/^(.+)\/(\d{1,3})$/);
    if (cidr) {
      const net = plainIp(cidr[1]!);
      const bits = Number(cidr[2]);
      if (!net || bits > (net.family === 4 ? 32 : 128)) return null;
      list.addSubnet(net.ip, bits, net.family === 4 ? 'ipv4' : 'ipv6');
      return (ip, family) => list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
    }
    const range = entry.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.)(\d{1,3})-(\d{1,3})$/);
    if (range) {
      const [from, to] = [Number(range[2]), Number(range[3])];
      if (from > to || to > 255 || isIP(`${range[1]}${from}`) !== 4) return null;
      list.addRange(`${range[1]}${from}`, `${range[1]}${to}`, 'ipv4');
      return (ip, family) => family === 4 && list.check(ip, 'ipv4');
    }
    const full = plainIp(entry);
    if (full) {
      list.addAddress(full.ip, full.family === 4 ? 'ipv4' : 'ipv6');
      return (ip, family) =>
        family === full.family && list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
    }
  } catch {
    return null;
  }
  // partial addresses: whole octets or whole IPv6 groups
  if (/^\d{1,3}(\.\d{1,3}){0,2}\.?$/.test(entry)) {
    const parts = entry.replace(/\.$/, '').split('.').map(Number);
    if (parts.every((p) => p <= 255))
      return (ip, family) => family === 4 && parts.every((p, i) => Number(ip.split('.')[i]) === p);
  }
  if (/^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){0,6}:?$/i.test(entry)) {
    const parts = entry
      .replace(/:$/, '')
      .split(':')
      .map((p) => Number.parseInt(p, 16));
    return (ip, family) => family === 6 && parts.every((p, i) => ipv6Groups(ip)[i] === p);
  }
  return null;
}

const entries = (spec: string) => spec.split(/[\s,;]+/).filter(Boolean);

/** Entries of an address list that cannot be read (empty when the list is valid). */
export function invalidIpListEntries(spec: string): string[] {
  return entries(spec).filter((e) => !matcher(e));
}

/** Is the address in the list? An unknown address (null) never is. */
export function ipInList(ip: string | null, spec: string): boolean {
  const addr = ip ? plainIp(ip) : null;
  if (!addr) return false;
  return entries(spec).some((e) => matcher(e)?.(addr.ip, addr.family) ?? false);
}
