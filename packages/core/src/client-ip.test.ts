import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER, clientIp, withClientIp } from './client-ip.ts';

describe('client address', () => {
  it('takes the address the trusted proxy saw, not what the client claims', () => {
    // Caddy replaces the header: one entry
    expect(clientIp('203.0.113.7', {})).toBe('203.0.113.7');
    // nginx appends: the client forged the first entry
    expect(clientIp('10.9.9.9, 203.0.113.7', {})).toBe('203.0.113.7');
    // a CDN and then Caddy: two proxies
    expect(clientIp('6.6.6.6, 198.51.100.4, 203.0.113.7', { TRUSTED_PROXY_HOPS: '2' })).toBe(
      '198.51.100.4',
    );
    expect(clientIp('203.0.113.7', { TRUSTED_PROXY_HOPS: '3' })).toBe('203.0.113.7');
    expect(clientIp('2001:db8::1', {})).toBe('2001:db8::1');
  });

  it('ignores the header without a proxy, and junk', () => {
    expect(clientIp('203.0.113.7', { TRUSTED_PROXY_HOPS: '0' })).toBeNull();
    expect(clientIp(null, {})).toBeNull();
    expect(clientIp(' , ', {})).toBeNull();
    expect(clientIp('evil<script>', {})).toBeNull();
  });

  it('hands the address on in its own header, which the client cannot set', () => {
    const forged = new Headers({
      'x-forwarded-for': '10.9.9.9, 203.0.113.7',
      [CLIENT_IP_HEADER]: '10.9.9.9',
      cookie: 'a=b',
    });
    const out = withClientIp(forged, {});
    expect(out.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
    expect(out.get('cookie')).toBe('a=b');
    expect(withClientIp(forged, { TRUSTED_PROXY_HOPS: '0' }).has(CLIENT_IP_HEADER)).toBe(false);
  });
});
