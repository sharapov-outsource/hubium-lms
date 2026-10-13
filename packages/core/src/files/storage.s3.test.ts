import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { S3Storage } from './storage.ts';

// Runs against a real S3-compatible server (RustFS in docker/compose.dev.yml and in CI):
// S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_ACCESS_KEY=… S3_TEST_SECRET_KEY=…
const endpoint = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!endpoint)('S3Storage', () => {
  const storage = () =>
    new S3Storage({
      endpoint,
      region: 'us-east-1',
      bucket: `hubium-test-${randomBytes(4).toString('hex')}`,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY,
      secretAccessKey: process.env.S3_TEST_SECRET_KEY,
    });

  it('creates a missing bucket once', async () => {
    const s = storage();
    expect(await s.ensureBucket()).toBe('created');
    expect(await s.ensureBucket()).toBe('exists');
  });

  it('stores, copies, signs and deletes objects', async () => {
    const s = storage();
    await s.ensureBucket();
    await s.put('blobs/a', Buffer.from('hello'), 'text/plain');
    await s.put('blobs/b', Readable.from([Buffer.from('streamed')]), 'text/plain');

    expect(await s.head('blobs/a')).toMatchObject({ size: 5, contentType: 'text/plain' });
    expect(await text(await s.getStream('blobs/b'))).toBe('streamed');

    await s.copy('blobs/a', 'blobs/c');
    expect(await text(await s.getStream('blobs/c'))).toBe('hello');

    const url = await s.signedReadUrl('blobs/a', { ttlSeconds: 60, filename: 'Отчёт.txt' });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");

    await s.delete('blobs/a');
    expect(await s.head('blobs/a')).toBeNull();
  });

  it('uploads a large stream of unknown length in parts', async () => {
    const s = storage();
    await s.ensureBucket();
    const chunk = randomBytes(1024 * 1024);
    await s.put('blobs/video', Readable.from(Array.from({ length: 12 }, () => chunk)), 'video/mp4');
    expect(await s.head('blobs/video')).toMatchObject({ size: 12 * 1024 * 1024 });
  });
});
