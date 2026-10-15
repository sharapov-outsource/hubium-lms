import { mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM_CONTEXT_ID, uuidv7 } from '@hubium/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { buildModuleCtx } from '../modules/module-ctx.ts';
import {
  canReadFile,
  checkFile,
  garbageCollectBlobs,
  isInlineSafe,
  listFiles,
  normalizeMimeType,
  reconcileBlobObjects,
  sanitizeFilename,
  servesInline,
  sniffMimeType,
  storeFile,
} from './files.ts';
import { FsStorage, getStorage, setStorage } from './storage.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('file helpers', () => {
  it('sniffs real types regardless of the declared one', () => {
    expect(sniffMimeType(PNG, 'text/html', 'x.html')).toBe('image/png');
    expect(sniffMimeType(Buffer.from('%PDF-1.7'), 'application/octet-stream', 'a.bin')).toBe(
      'application/pdf',
    );
    expect(
      sniffMimeType(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'text/plain',
        'a.txt',
      ),
    ).toBe('image/svg+xml');
    expect(sniffMimeType(Buffer.from('hello'), 'text/plain', 'a.txt')).toBe('text/plain');
  });
  it('keeps declared office types for zip containers', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(sniffMimeType(zip, docx, 'a.docx')).toBe(docx);
    expect(sniffMimeType(zip, '', 'a.zip')).toBe('application/zip');
  });
  it('only marks safe types inline', () => {
    expect(isInlineSafe('image/png')).toBe(true);
    expect(isInlineSafe('text/html')).toBe(false);
    // SVG runs scripts: inline only where the app sends it with a sandbox (local storage),
    // never straight from S3, where nothing adds one
    expect(servesInline('image/svg+xml', { sandboxed: true })).toBe(true);
    expect(servesInline('image/svg+xml', { sandboxed: false })).toBe(false);
    expect(servesInline('image/png', { sandboxed: false })).toBe(true);
    expect(servesInline('text/html', { sandboxed: true })).toBe(false);
    expect(isInlineSafe('application/zip')).toBe(false);
    // browsers take the last type of a list: such values must never pass as "text/plain"
    expect(isInlineSafe('text/plain,text/html')).toBe(false);
    expect(isInlineSafe('video/mp4')).toBe(true);
  });
  it('never stores a smuggled or malformed declared type', () => {
    const html = Buffer.from('<script>alert(1)</script>');
    expect(sniffMimeType(html, 'text/plain,text/html', 'x.html')).toBe('application/octet-stream');
    expect(sniffMimeType(html, 'text/plain; charset=utf-8', 'x.txt')).toBe('text/plain');
    expect(normalizeMimeType('Text/HTML ')).toBe('text/html');
    expect(normalizeMimeType('text/plain\r\nX-Evil: 1')).toBe('application/octet-stream');
  });
  it('sanitizes file names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('  ')).toBe('file');
  });
});

describe('FsStorage', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hubium-fs-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('rejects path traversal keys', async () => {
    const s = new FsStorage(dir, 'secret');
    await expect(s.put('../evil', Buffer.from('x'), 'text/plain')).rejects.toThrow(
      /Invalid storage key/,
    );
  });
  it('signed tokens verify and expire', async () => {
    const s = new FsStorage(dir, 'secret');
    const url = await s.signedReadUrl('blobs/aa/key', { ttlSeconds: 60, filename: 'a.txt' });
    const token = url.split('/files/blob/')[1]!;
    expect(s.verifyToken(token)?.key).toBe('blobs/aa/key');
    expect(s.verifyToken(`${token}x`)).toBeNull();
    const expired = await s.signedReadUrl('k', { ttlSeconds: -10 });
    expect(s.verifyToken(expired.split('/files/blob/')[1]!)).toBeNull();
  });
});

describe('file service', () => {
  const t = useTestDb({ profile: 'demo' });
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hubium-files-'));
    setStorage(new FsStorage(dir, 'secret'));
  });
  afterAll(async () => {
    setStorage(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('stores, dedupes blobs and copies rows', async () => {
    const a = await storeFile(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'site',
      area: 'branding',
      name: 'logo.png',
      data: PNG,
    });
    const b = await storeFile(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'site',
      area: 'test',
      name: 'same.png',
      data: PNG,
    });
    expect(a.blobId).toBe(b.blobId);
    expect(a.mimeType).toBe('image/png');
  });

  it('enforces size and type limits', async () => {
    await expect(
      storeFile(t.db, {
        contextId: SYSTEM_CONTEXT_ID,
        component: 'site',
        area: 'x',
        name: 'a.txt',
        data: Buffer.alloc(2048),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ fieldErrors: { file: [expect.stringMatching(/larger/)] } });
    await expect(
      storeFile(t.db, {
        contextId: SYSTEM_CONTEXT_ID,
        component: 'site',
        area: 'x',
        name: 'a.txt',
        data: Buffer.from('hi'),
        mimeType: 'text/plain',
        allowedTypes: /^image\//,
      }),
    ).rejects.toMatchObject({ fieldErrors: { file: [expect.stringMatching(/not allowed/)] } });
  });

  it('checks an upload before what it belongs to is made, and stores it once', async () => {
    await expect(
      checkFile(t.db, { name: 'big.png', data: Buffer.alloc(2048), maxBytes: 1024 }),
    ).rejects.toMatchObject({ fieldErrors: { file: [expect.stringMatching(/larger/)] } });
    await expect(
      checkFile(t.db, { name: 'a.txt', data: Buffer.from('hi'), allowedTypes: /^image\// }),
    ).rejects.toMatchObject({ fieldErrors: { file: [expect.stringMatching(/not allowed/)] } });
    const data = Buffer.concat([PNG, Buffer.from('checked first')]);
    await checkFile(t.db, { name: 'cover.png', data, allowedTypes: /^image\// });
    const blobs = await t.db.fileBlob.count();
    const f = await storeFile(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'site',
      area: 'checked',
      name: 'cover.png',
      data,
    });
    // the content checked is the content stored: no second copy
    expect(await t.db.fileBlob.count()).toBe(blobs);
    expect(f.mimeType).toBe('image/png');
  });

  it('replace swaps the file at the same address', async () => {
    await storeFile(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'site',
      area: 'r',
      name: 'a.txt',
      data: Buffer.from('one'),
      mimeType: 'text/plain',
    });
    await storeFile(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'site',
      area: 'r',
      name: 'a.txt',
      data: Buffer.from('two'),
      mimeType: 'text/plain',
      replace: true,
    });
    expect(
      await listFiles(t.db, { contextId: SYSTEM_CONTEXT_ID, component: 'site', area: 'r' }),
    ).toHaveLength(1);
  });

  it('ACL: branding is public, unknown areas are admin-only', async () => {
    const logo = await t.db.file.findFirstOrThrow({ where: { area: 'branding' } });
    const other = await t.db.file.findFirstOrThrow({ where: { area: 'test' } });
    const student = await ctxFor(t.db, 'student1@hubium.local');
    const admin = await ctxFor(t.db, 'admin@test.local');
    expect(await canReadFile(student, logo)).toBe(true);
    expect(await canReadFile(student, other)).toBe(false);
    expect(await canReadFile(admin, other)).toBe(true);
  });

  it('GC removes unreferenced blobs only', async () => {
    const f = await storeFile(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'site',
      area: 'gc',
      name: 'g.txt',
      data: Buffer.from('garbage'),
      mimeType: 'text/plain',
    });
    await t.db.file.delete({ where: { id: f.id } });
    expect(await garbageCollectBlobs(t.db, -1000)).toBeGreaterThanOrEqual(1);
    expect(await t.db.fileBlob.findUnique({ where: { id: f.blobId } })).toBeNull();
    expect(await t.db.fileBlob.count()).toBeGreaterThan(0);
  });

  it('GC goes on past one batch until no unreferenced blob is left', async () => {
    const old = new Date(Date.now() - 2 * 86_400_000);
    await t.db.fileBlob.createMany({
      data: Array.from({ length: 1201 }, (_, i) => ({
        id: uuidv7(),
        storageKey: `blobs/gc/orphan-${i}`,
        size: 1,
        mimeType: 'text/plain',
        sha256: `gc-batch-${i}`,
        createdAt: old,
      })),
    });
    expect(await garbageCollectBlobs(t.db)).toBeGreaterThanOrEqual(1201);
    expect(await t.db.fileBlob.count({ where: { sha256: { startsWith: 'gc-batch-' } } })).toBe(0);
  });

  it('removes stored content no row names, once it is old enough', async () => {
    const kept = await storeFile(t.db, {
      contextId: SYSTEM_CONTEXT_ID,
      component: 'site',
      area: 'gc',
      name: 'kept.txt',
      data: Buffer.from('kept content'),
      mimeType: 'text/plain',
    });
    const blob = await t.db.fileBlob.findUniqueOrThrow({ where: { id: kept.blobId } });
    // written by an upload whose transaction rolled back: the store has it, no row does
    const orphan = 'blobs/ab/01a1404a-0000-7000-8000-0000000000ab';
    const fresh = 'blobs/cd/01a1404a-0000-7000-8000-0000000000cd';
    await getStorage().put(orphan, Buffer.from('lost'), 'text/plain');
    await getStorage().put(fresh, Buffer.from('being written'), 'text/plain');
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const key of [orphan, blob.storageKey]) await utimes(path.join(dir, key), old, old);
    expect(await reconcileBlobObjects(t.db)).toBe(1);
    expect(await getStorage().head(orphan)).toBeNull();
    expect(await getStorage().head(fresh)).not.toBeNull();
    expect(await getStorage().head(blob.storageKey)).not.toBeNull();
  });

  it("a module's stored objects go when the operation commits, not before", async () => {
    await getStorage().put('mod/test/x.txt', Buffer.from('x'), 'text/plain');
    const after: (() => void | Promise<void>)[] = [];
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const mctx = buildModuleCtx({
      ...ctx,
      afterCommit: (fn: () => void) => after.push(fn),
    } as never);
    await mctx.storage.delete(['mod/test/x.txt']);
    // a rollback now would keep the rows naming it, and the object with them
    expect(await getStorage().head('mod/test/x.txt')).not.toBeNull();
    for (const fn of after) await fn();
    expect(await getStorage().head('mod/test/x.txt')).toBeNull();
  });
});
