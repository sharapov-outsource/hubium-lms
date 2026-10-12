import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPublicUrl,
  checkUrlShape,
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
    ])
      expect(isInternalAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2a00:1450:4010::8a', '172.32.0.1'])
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
    const server = createServer((req, res) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest' });
        return res.end();
      }
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/internal/);
      process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';
      expect(await (await safeFetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
      // an allowed host cannot redirect into another internal address
      await expect(safeFetch(`http://127.0.0.1:${port}/hop`)).rejects.toThrow(/169\.254/);
    } finally {
      server.close();
    }
  });
});
