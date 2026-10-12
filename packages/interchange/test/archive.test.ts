import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { gunzipLimited, unzipLimited } from '../src/archive.ts';
import { readBackup } from '../src/hubium.ts';
import { readMbz } from '../src/mbz.ts';

const tooLarge = { fieldErrors: { file: ['The archive is too large to import'] } };

describe('archive limits', () => {
  const zip = zipSync({ 'a.txt': new Uint8Array(4000), 'b.txt': new Uint8Array(10) });

  it('unzips within the limits', () => {
    const files = unzipLimited(zip, { bytes: 5000, entries: 2 });
    expect(Object.keys(files)).toEqual(['a.txt', 'b.txt']);
  });

  it('rejects zips that expand past the size or entry limit', () => {
    expect(() => unzipLimited(zip, { bytes: 3000, entries: 10 })).toThrow(
      expect.objectContaining(tooLarge),
    );
    expect(() => unzipLimited(zip, { bytes: 1e6, entries: 1 })).toThrow(
      expect.objectContaining(tooLarge),
    );
    expect(() => readBackup(zip, { bytes: 3000, entries: 10 })).toThrow(
      expect.objectContaining(tooLarge),
    );
  });

  it('caps gunzip output', () => {
    const gz = gzipSync(Buffer.alloc(100_000));
    expect(gunzipLimited(gz, { bytes: 200_000, entries: 1 })).toHaveLength(100_000);
    expect(() => gunzipLimited(gz, { bytes: 1000, entries: 1 })).toThrow(
      expect.objectContaining(tooLarge),
    );
  });

  it('applies the limits to Moodle backups', async () => {
    await expect(
      readMbz(gzipSync(Buffer.alloc(100_000)), { bytes: 1000, entries: 10 }),
    ).rejects.toMatchObject(tooLarge);
    await expect(readMbz(Buffer.from(zip), { bytes: 1e6, entries: 1 })).rejects.toMatchObject(
      tooLarge,
    );
  });
});
