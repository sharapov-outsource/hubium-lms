import { isIP } from 'node:net';

/**
 * The client's address from X-Forwarded-For. Each proxy in front of the app appends the
 * address it received the request from, so with TRUSTED_PROXY_HOPS proxies (default 1:
 * Caddy or nginx) the client is that many entries from the right; anything further left
 * came from the client itself and can be forged. 0 means no proxy: the header is ignored.
 */
export function clientIp(
  forwardedFor: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const parsed = Number.parseInt(env.TRUSTED_PROXY_HOPS ?? '', 10);
  const hops = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
  if (!hops || !forwardedFor) return null;
  const chain = forwardedFor
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return null;
  const ip = chain[Math.max(0, chain.length - hops)]!.replace(/^\[|\]$/g, '');
  return isIP(ip) ? ip : null;
}

/**
 * The request header that carries clientIp() to Better Auth, which reads the address from
 * it. On its own Better Auth trusts X-Forwarded-For only when it holds one address: behind
 * a CDN it saw none, so every sign-in on the site shared one rate-limit bucket and sessions
 * had no address.
 */
export const CLIENT_IP_HEADER = 'x-hubium-client-ip';

/** The headers with CLIENT_IP_HEADER set from X-Forwarded-For; a value the client sent goes. */
export function withClientIp(headers: Headers, env: NodeJS.ProcessEnv = process.env): Headers {
  const out = new Headers(headers);
  out.delete(CLIENT_IP_HEADER);
  const ip = clientIp(headers.get('x-forwarded-for'), env);
  if (ip) out.set(CLIENT_IP_HEADER, ip);
  return out;
}
