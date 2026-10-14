import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../../test/helpers.ts';
import { getEnv } from '../env.ts';
import { UnavailableError, ValidationError } from '../errors.ts';
import { environmentChecks } from '../system/health.ts';
import { antivirusVersion, assertClean } from './antivirus.ts';
import { storeFile, storeFileFromPath } from './files.ts';
import { FsStorage, setStorage } from './storage.ts';

// A fake clamd on a unix socket: answers VERSION and INSTREAM like the real one, finding
// the EICAR test string. Set before anything reads (and caches) the environment.
const dir = mkdtempSync(path.join(os.tmpdir(), 'clamd-'));
const SOCKET = path.join(dir, 's');
process.env.CLAMAV_URL = `unix://${SOCKET}`;

// assembled at runtime so that this file itself is not flagged by scanners
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(
  '',
);

let mode: 'normal' | 'silent' | 'tooBig' = 'normal';
const scans: { chunks: number[]; bytes: number }[] = [];

function handle(sock: Socket) {
  let buf = Buffer.alloc(0);
  let command: string | null = null;
  const content: Buffer[] = [];
  const chunks: number[] = [];
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    if (command === null) {
      const end = buf.indexOf(0);
      if (end < 0) return;
      command = buf.subarray(0, end).toString();
      buf = buf.subarray(end + 1);
      if (command === 'zVERSION') return void sock.end('ClamAV 1.4.3/27791/fake\0');
    }
    if (command !== 'zINSTREAM') return void sock.end('UNKNOWN COMMAND\0');
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len === 0) {
        scans.push({ chunks, bytes: chunks.reduce((a, b) => a + b, 0) });
        if (mode === 'silent') return;
        if (mode === 'tooBig') return void sock.end('INSTREAM size limit exceeded. ERROR\0');
        const found = Buffer.concat(content).includes(EICAR);
        return void sock.end(found ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
      if (buf.length < 4 + len) return;
      chunks.push(len);
      content.push(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
  });
  sock.on('error', () => {});
}

const listen = () =>
  new Promise<Server>((resolve) => {
    rmSync(SOCKET, { force: true });
    const s = createServer(handle);
    s.listen(SOCKET, () => resolve(s));
  });

describe('virus scanning of uploads', () => {
  const t = useTestDb({ profile: 'minimal' });
  let server: Server;
  const store = (name: string, data: Buffer) =>
    storeFile(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'test',
      area: 'av',
      name,
      data,
    });
  const blobOf = async (fileId: string) =>
    (await t.db.file.findUniqueOrThrow({ where: { id: fileId }, include: { blob: true } })).blob;

  beforeAll(async () => {
    setStorage(new FsStorage(path.join(dir, 'storage'), 'secret'));
    server = await listen();
  });
  afterAll(async () => {
    setStorage(undefined);
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    mode = 'normal';
    scans.length = 0;
  });

  it('stores clean files, marked as scanned, sent in small chunks', async () => {
    const data = Buffer.alloc(200 * 1024, 'a');
    const f = await store('clean.txt', data);
    expect((await blobOf(f.id)).scannedAt).toBeInstanceOf(Date);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.bytes).toBe(data.length);
    expect(Math.max(...scans[0]!.chunks)).toBeLessThanOrEqual(64 * 1024);
  });

  it('streams files stored from disk', async () => {
    const file = path.join(dir, 'big.bin');
    await writeFile(file, Buffer.alloc(300 * 1024, 'b'));
    const f = await storeFileFromPath(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'test',
      area: 'av',
      name: 'big.bin',
      filePath: file,
    });
    expect((await blobOf(f.id)).scannedAt).toBeInstanceOf(Date);
    expect(scans[0]!.bytes).toBe(300 * 1024);
  });

  it('rejects malware and stores nothing', async () => {
    const blobs = await t.db.fileBlob.count();
    const err = await store('eicar.com', Buffer.from(EICAR)).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors.file[0]).toContain('Eicar-Test-Signature');
    expect(await t.db.fileBlob.count()).toBe(blobs);
  });

  it('scans known content again only if it was stored without a scan', async () => {
    const data = Buffer.from('the same lecture notes');
    const first = await store('notes.txt', data);
    await store('notes-copy.txt', data);
    expect(scans).toHaveLength(1);
    // as if stored before the scanner was set up
    const blob = await blobOf(first.id);
    await t.db.fileBlob.update({ where: { id: blob.id }, data: { scannedAt: null } });
    const again = await store('notes-again.txt', data);
    expect(scans).toHaveLength(2);
    expect((await blobOf(again.id)).id).toBe(blob.id);
    expect((await blobOf(again.id)).scannedAt).toBeInstanceOf(Date);
  });

  it('skips files above the size limit and fails closed on scanner errors', async () => {
    const env = { ...getEnv(), CLAMAV_MAX_SCAN_MB: 1, CLAMAV_TIMEOUT_MS: 300 };
    const meta = (size: number) => ({ name: 'x.bin', size });
    expect(await assertClean({ data: Buffer.alloc(10) }, meta(2 * 1024 * 1024), env)).toBe(false);
    expect(scans).toHaveLength(0);

    mode = 'silent';
    await expect(assertClean({ data: Buffer.alloc(10) }, meta(10), env)).rejects.toBeInstanceOf(
      UnavailableError,
    );
    mode = 'tooBig';
    await expect(assertClean({ data: Buffer.alloc(10) }, meta(10), env)).rejects.toThrow(
      /size limit exceeded/,
    );
  });

  it('reports the scanner on the environment page and refuses uploads without it', async () => {
    expect(await antivirusVersion()).toMatch(/^ClamAV 1\.4\.3/);
    const ok = (await environmentChecks(t.db)).find((c) => c.key === 'antivirus');
    expect(ok).toMatchObject({ status: 'ok', detail: expect.stringContaining('ClamAV') });

    await new Promise((r) => server.close(r));
    try {
      const err = await store('late.txt', Buffer.from('handed in late')).catch((e) => e);
      expect(err).toBeInstanceOf(UnavailableError);
      expect(err.status).toBe(503);
      const down = (await environmentChecks(t.db)).find((c) => c.key === 'antivirus');
      expect(down?.status).toBe('error');
    } finally {
      server = await listen();
    }
  });
});
