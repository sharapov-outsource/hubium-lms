import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { safeEqual } from './crypto.ts';
import {
  assertPublicUrl,
  checkUrlShape,
  invalidIpListEntries,
  ipInList,
  isInternalAddress,
  safeFetch,
  UnsafeUrlError,
} from './net.ts';

afterEach(() => {
  delete process.env.SSRF_ALLOW_HOSTS;
});

describe('SSRF guard', () => {
  it('classifies internal addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::10.0.0.1',
      '2002:7f00:1::1',
      '::127.0.0.1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    ])
      expect(isInternalAddress(ip), ip).toBe(true);
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '2a00:1450:4010::8a',
      '172.32.0.1',
      '::ffff:808:808',
      '64:ff9b::808:808',
      '2002:808:808::1',
    ])
      expect(isInternalAddress(ip), ip).toBe(false);
  });

  it('refuses internal, odd-scheme and credentialed URLs', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/x')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicUrl('http://[::1]:8080/')).rejects.toThrow(/internal/);
    await expect(assertPublicUrl('http://localhost/')).rejects.toThrow(/internal/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(assertPublicUrl('https://user:pw@8.8.8.8/')).rejects.toThrow(/Credentials/);
    await expect(assertPublicUrl('https://8.8.8.8/')).resolves.toBeInstanceOf(URL);
    // the URL parser turns ::ffff:127.0.0.1 into ::ffff:7f00:1
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/internal/);
  });

  it('checks URL shape without DNS', () => {
    expect(() => checkUrlShape('http://localhost:11434/v1')).toThrow(/internal/);
    expect(() => checkUrlShape('http://10.0.0.5/')).toThrow(/internal/);
    expect(() => checkUrlShape('ftp://x.example/')).toThrow(/http/);
    expect(checkUrlShape('https://tool.example/jwks').host).toBe('tool.example');
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    expect(checkUrlShape('http://localhost:11434/v1').port).toBe('11434');
  });

  it('honours SSRF_ALLOW_HOSTS and checks redirect hops', async () => {
    const seen: Record<string, string | undefined>[] = [];
    const server = createServer((req, res) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest' });
        return res.end();
      }
      if (req.url === '/away') {
        // same server, other origin (localhost vs 127.0.0.1)
        res.writeHead(303, { location: `http://localhost:${port}/landed` });
        return res.end();
      }
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization });
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/internal/);
      process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';
      expect(await (await safeFetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
      // an allowed host cannot redirect into another internal address
      await expect(safeFetch(`http://127.0.0.1:${port}/hop`)).rejects.toThrow(/169\.254/);
      // credentials stay behind on a cross-origin redirect; 303 turns POST into GET
      process.env.SSRF_ALLOW_HOSTS = '127.0.0.1,localhost';
      await safeFetch(`http://127.0.0.1:${port}/away`, {
        method: 'POST',
        body: 'x',
        headers: { authorization: 'Bearer secret' },
      });
      expect(seen.at(-1)).toEqual({ url: '/landed', method: 'GET', auth: undefined });
    } finally {
      server.close();
    }
  });
});

describe('address lists', () => {
  const list = '192.168.1.0/24, 10.1, 172.16.5.10-20 ; 203.0.113.9 2001:db8::/32 fe80';
  it('matches CIDR blocks, partial addresses, ranges and single addresses', () => {
    for (const ip of [
      '192.168.1.200',
      '10.1.0.1',
      '10.1.255.3',
      '172.16.5.15',
      '203.0.113.9',
      '::ffff:203.0.113.9',
      '2001:db8:1::5',
      'fe80::1',
    ])
      expect(ipInList(ip, list), ip).toBe(true);
    for (const ip of ['192.168.2.1', '10.10.0.1', '172.16.5.21', '203.0.113.90', '2001:db9::1'])
      expect(ipInList(ip, list), ip).toBe(false);
    expect(ipInList(null, list)).toBe(false);
  });

  it('reports entries it cannot read', () => {
    expect(invalidIpListEntries(list)).toEqual([]);
    expect(invalidIpListEntries('10.0.0.0/33, 1.2.3.4-2, office, 300.1')).toEqual([
      '10.0.0.0/33',
      '1.2.3.4-2',
      'office',
      '300.1',
    ]);
  });
});

describe('secret comparison', () => {
  it('compares in constant time and only equal strings match', () => {
    expect(safeEqual('Qu1z!', 'Qu1z!')).toBe(true);
    expect(safeEqual('qu1z!', 'Qu1z!')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
