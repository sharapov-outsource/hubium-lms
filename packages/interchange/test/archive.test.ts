import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import tar from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { openArchive, withArchive } from '../src/archive.ts';
import { readBackup } from '../src/hubium.ts';
import { readMbz } from '../src/mbz.ts';

const tooLarge = { fieldErrors: { file: ['The archive is too large to import'] } };
const damaged = { fieldErrors: { file: ['The archive is damaged'] } };

async function tarOf(entries: { name: string; data: Buffer }[]): Promise<Buffer> {
  const pack = tar.pack();
  for (const e of entries) pack.entry({ name: e.name }, e.data);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe('archive limits', () => {
  const zip = zipSync({ 'a.txt': new Uint8Array(4000), 'b.txt': new Uint8Array(10) });

  it('unpacks within the limits and reads a file at a time', async () => {
    const files = await withArchive(
      zip,
      (a) => ({ names: a.names(), a: a.get('a.txt')?.length, none: a.get('c.txt') }),
      { bytes: 5000, entries: 2, ratio: 200 },
    );
    expect(files).toEqual({ names: ['a.txt', 'b.txt'], a: 4000, none: undefined });
  });

  it('rejects zips that expand past the size or entry limit', async () => {
    await expect(openArchive(zip, { bytes: 3000, entries: 10, ratio: 200 })).rejects.toMatchObject(
      tooLarge,
    );
    await expect(openArchive(zip, { bytes: 1e6, entries: 1, ratio: 200 })).rejects.toMatchObject(
      tooLarge,
    );
    await expect(
      withArchive(zip, readBackup, { bytes: 3000, entries: 10, ratio: 200 }),
    ).rejects.toMatchObject(tooLarge);
  });

  it('does not believe the sizes a zip claims', async () => {
    // a stored file whose headers claim a gigabyte: fflate would set that much memory aside
    const lying = Buffer.from(zipSync({ 'a.txt': new Uint8Array(100) }, { level: 0 }));
    for (let i = 0; i + 4 <= lying.length; i++) {
      const sig = lying.readUInt32LE(i);
      if (sig === 0x04034b50) lying.writeUInt32LE(1024 ** 3, i + 22);
      if (sig === 0x02014b50) lying.writeUInt32LE(1024 ** 3, i + 24);
    }
    await expect(
      openArchive(lying, { bytes: 1e12, entries: 10, ratio: 1e12 }),
    ).rejects.toMatchObject(damaged);
    await expect(openArchive(lying)).rejects.toMatchObject(damaged);
  });

  it('counts what a .tar.gz unpacks to and refuses paths out of it', async () => {
    const gz = gzipSync(await tarOf([{ name: 'big.bin', data: Buffer.alloc(100_000) }]));
    await expect(openArchive(gz, { bytes: 1000, entries: 10, ratio: 200 })).rejects.toMatchObject(
      tooLarge,
    );
    expect(
      await withArchive(gz, (a) => a.get('big.bin')?.length, {
        bytes: 200_000,
        entries: 10,
        ratio: 200,
      }),
    ).toBe(100_000);
    const escaping = gzipSync(await tarOf([{ name: '../evil.txt', data: Buffer.from('x') }]));
    await expect(openArchive(escaping)).rejects.toMatchObject(damaged);
    await expect(openArchive(Buffer.from('not an archive'))).rejects.toMatchObject(damaged);
  });

  it('applies the limits to Moodle backups', async () => {
    const gz = gzipSync(await tarOf([{ name: 'moodle_backup.xml', data: Buffer.alloc(100_000) }]));
    await expect(readMbz(gz, { bytes: 1000, entries: 10, ratio: 200 })).rejects.toMatchObject(
      tooLarge,
    );
    await expect(
      readMbz(Buffer.from(zip), { bytes: 1e6, entries: 1, ratio: 200 }),
    ).rejects.toMatchObject(tooLarge);
  });
});
