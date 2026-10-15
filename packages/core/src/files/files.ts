import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { type Db, type File, type Prisma, SYSTEM_CONTEXT_ID, uuidv7 } from '@hubium/db';
import { log } from '@hubium/log';
import type { RequestContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { assertClean } from './antivirus.ts';
import { getStorage } from './storage.ts';

const logger = log('files');

type Tx = Prisma.TransactionClient | Db;

// File service. A File row addresses (context, component, area, itemId, path, name) and
// points to an immutable FileBlob; copying a course copies rows, not bytes.

export type FileAccessCheck = (ctx: RequestContext, file: File) => Promise<boolean>;
const areaAccess = new Map<string, FileAccessCheck>();
const prefixAccess: [string, FileAccessCheck][] = [];

/** Registers who may read files of a component/area. Unregistered areas are denied. */
export function registerFileArea(component: string, area: string, check: FileAccessCheck): void {
  areaAccess.set(`${component}/${area}`, check);
}

/** Fallback check for every component starting with `prefix` (e.g. "mod."). */
export function registerFileComponentPrefix(prefix: string, check: FileAccessCheck): void {
  prefixAccess.push([prefix, check]);
}

export async function canReadFile(ctx: RequestContext, file: File): Promise<boolean> {
  if (file.status !== 'READY') return false;
  if (ctx.perm.isSiteAdmin) return true;
  const check =
    areaAccess.get(`${file.component}/${file.area}`) ??
    prefixAccess.find(([p]) => file.component.startsWith(p))?.[1];
  if (!check) return false;
  return check(ctx, file);
}

const SIGNATURES: [string, number[]][] = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
  ['application/zip', [0x50, 0x4b, 0x03, 0x04]],
];

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * A client-declared type reduced to a single, well-formed `type/subtype`. Lists such as
 * `text/plain,text/html` (browsers pick the last one) or junk become octet-stream.
 */
export function normalizeMimeType(declared: string | null | undefined): string {
  const t = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  return MIME_RE.test(t) ? t : 'application/octet-stream';
}

/** Sniffs the real type of common formats; falls back to the declared type. */
export function sniffMimeType(data: Buffer, rawDeclared: string, name: string): string {
  const declared = normalizeMimeType(rawDeclared);
  for (const [mime, sig] of SIGNATURES) {
    if (sig.every((b, i) => data[i] === b)) {
      if (mime === 'application/zip') {
        // docx/xlsx/pptx/scorm are zips; keep the declared type when it is a zip family.
        return declared && declared !== 'application/octet-stream' ? declared : mime;
      }
      return mime;
    }
  }
  if (
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  const head = data.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (
    name.toLowerCase().endsWith('.svg') ||
    head.startsWith('<svg') ||
    (head.startsWith('<?xml') && head.includes('<svg'))
  ) {
    return 'image/svg+xml';
  }
  return declared || 'application/octet-stream';
}

/** Types that may be shown inline; everything else downloads. HTML/SVG get a sandbox CSP. */
export function isInlineSafe(mime: string): boolean {
  return /^(image\/(png|jpeg|gif|webp|svg\+xml)|application\/pdf|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|text\/plain|text\/vtt)$/.test(
    mime,
  );
}

/**
 * Whether a file of this type opens in the browser rather than downloads. SVG can run
 * scripts: only where the answer carries a sandbox CSP (`sandboxed`, the app serving local
 * storage), never from S3, where nothing adds one.
 */
export function servesInline(mime: string, opts: { sandboxed: boolean }): boolean {
  return isInlineSafe(mime) && (opts.sandboxed || mime !== 'image/svg+xml');
}

export function sanitizeFilename(name: string): string {
  const base = name
    .replace(/[\\/]/g, '_')
    .replace(/\p{Cc}/gu, '')
    .trim();
  return (base || 'file').slice(0, 200);
}

export interface StoreFileInput {
  contextId: string;
  component: string;
  area: string;
  itemId?: string;
  path?: string;
  name: string;
  mimeType?: string;
  data: Buffer;
  uploadedById?: string | null;
  maxBytes?: number;
  allowedTypes?: RegExp;
  /** Replace an existing file with the same address. */
  replace?: boolean;
}

/**
 * The blob for this content: one already stored (deduplicated by hash) or a new one. New
 * content is scanned for malware first when a scanner is configured, and so is a stored
 * blob that was saved before scanning was turned on.
 */
async function storeBlob(
  db: Tx,
  content: { data: Buffer } | { filePath: string },
  meta: { name: string; size: number; sha256: string; mimeType: string },
) {
  const existing = await db.fileBlob.findFirst({
    where: { sha256: meta.sha256, size: meta.size },
  });
  if (existing?.scannedAt) return existing;
  const scanned = await assertClean(content, meta);
  if (existing)
    return scanned
      ? db.fileBlob.update({ where: { id: existing.id }, data: { scannedAt: new Date() } })
      : existing;
  const id = uuidv7();
  const storageKey = `blobs/${id.slice(-2)}/${id}`;
  await getStorage().put(
    storageKey,
    'data' in content ? content.data : createReadStream(content.filePath),
    meta.mimeType,
  );
  return db.fileBlob.create({
    data: {
      id,
      storageKey,
      size: meta.size,
      mimeType: meta.mimeType,
      sha256: meta.sha256,
      scannedAt: scanned ? new Date() : null,
    },
  });
}

type FileCheck = Pick<StoreFileInput, 'name' | 'mimeType' | 'data' | 'maxBytes' | 'allowedTypes'>;

/** The size and type checks of an upload: a ValidationError when it does not pass. */
function checkLimits(input: FileCheck) {
  const name = sanitizeFilename(input.name);
  if (input.maxBytes && input.data.length > input.maxBytes) {
    throw new ValidationError({
      file: [`File is larger than ${Math.round(input.maxBytes / 1024)} KB`],
    });
  }
  const mimeType = sniffMimeType(input.data, input.mimeType ?? '', name);
  if (input.allowedTypes && !input.allowedTypes.test(mimeType)) {
    throw new ValidationError({ file: [`File type ${mimeType} is not allowed`] });
  }
  const sha256 = createHash('sha256').update(input.data).digest('hex');
  return { name, mimeType, sha256, size: input.data.length };
}

/**
 * Everything storeFile checks of an upload (size, type, malware), done before what the file
 * belongs to is made: a course with its cover, an activity with its files. The content is
 * stored too, so storeFile afterwards finds it scanned; were the rest to fail, the unused
 * content goes with the next garbage collection.
 */
export async function checkFile(db: Tx, input: FileCheck): Promise<void> {
  const meta = checkLimits(input);
  await storeBlob(db, { data: input.data }, meta);
}

export async function storeFile(db: Tx, input: StoreFileInput): Promise<File> {
  const { name, mimeType, sha256 } = checkLimits(input);
  const blob = await storeBlob(
    db,
    { data: input.data },
    { name, size: input.data.length, sha256, mimeType },
  );
  const where = {
    contextId: input.contextId,
    component: input.component,
    area: input.area,
    itemId: input.itemId ?? '',
    path: input.path ?? '/',
    name,
  };
  if (input.replace) {
    await db.file.deleteMany({ where });
  }
  return db.file.create({
    data: {
      ...where,
      blobId: blob.id,
      mimeType,
      size: input.data.length,
      uploadedById: input.uploadedById ?? null,
    },
  });
}

/**
 * Stores a file from a local path without loading it into memory (large uploads):
 * hashes it while streaming, deduplicates by content and streams it to storage.
 */
export async function storeFileFromPath(
  db: Tx,
  input: Omit<StoreFileInput, 'data'> & { filePath: string },
): Promise<File> {
  const name = sanitizeFilename(input.name);
  const { size } = await stat(input.filePath);
  if (input.maxBytes && size > input.maxBytes) {
    throw new ValidationError({
      file: [`File is larger than ${Math.round(input.maxBytes / 1024)} KB`],
    });
  }
  const fh = await open(input.filePath, 'r');
  const head = Buffer.alloc(Math.min(size, 4100));
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  const mimeType = sniffMimeType(head, input.mimeType ?? '', name);
  if (input.allowedTypes && !input.allowedTypes.test(mimeType)) {
    throw new ValidationError({ file: [`File type ${mimeType} is not allowed`] });
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(input.filePath)) hash.update(chunk as Buffer);
  const sha256 = hash.digest('hex');
  const blob = await storeBlob(db, { filePath: input.filePath }, { name, size, sha256, mimeType });
  const where = {
    contextId: input.contextId,
    component: input.component,
    area: input.area,
    itemId: input.itemId ?? '',
    path: input.path ?? '/',
    name,
  };
  if (input.replace) await db.file.deleteMany({ where });
  return db.file.create({
    data: { ...where, blobId: blob.id, mimeType, size, uploadedById: input.uploadedById ?? null },
  });
}

/** Files of an area; without `itemId`, those of every item (like deleteFiles). */
export async function listFiles(
  db: Tx,
  q: { contextId: string; component: string; area: string; itemId?: string },
): Promise<File[]> {
  return db.file.findMany({
    where: {
      contextId: q.contextId,
      component: q.component,
      area: q.area,
      ...(q.itemId !== undefined ? { itemId: q.itemId } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { path: 'asc' }, { name: 'asc' }],
  });
}

export async function deleteFiles(
  db: Tx,
  q: { contextId: string; component: string; area: string; itemId?: string; ids?: string[] },
): Promise<number> {
  const r = await db.file.deleteMany({
    where: {
      contextId: q.contextId,
      component: q.component,
      area: q.area,
      ...(q.itemId !== undefined ? { itemId: q.itemId } : {}),
      ...(q.ids ? { id: { in: q.ids } } : {}),
    },
  });
  return r.count;
}

/** Copies file rows to a new address (same blobs). Used by duplicate/restore. */
export async function copyFiles(
  db: Tx,
  from: { contextId: string; component: string; area: string; itemId?: string },
  to: { contextId: string; component?: string; area?: string; itemId?: string },
): Promise<number> {
  const files = await listFiles(db, from);
  for (const f of files) {
    await db.file.create({
      data: {
        blobId: f.blobId,
        contextId: to.contextId,
        component: to.component ?? f.component,
        area: to.area ?? f.area,
        itemId: to.itemId ?? f.itemId,
        path: f.path,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size,
        uploadedById: f.uploadedById,
        sortOrder: f.sortOrder,
      },
    });
  }
  return files.length;
}

/**
 * Deletes stored blob objects that no FileBlob row names, older than the grace period: the
 * content written before the transaction that was to record it rolled back (an upload
 * refused halfway, a failed import). Their rows were never committed, so only the store
 * knows them.
 */
export async function reconcileBlobObjects(db: Db, olderThanMs = 24 * 3600_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const storage = getStorage();
  let deleted = 0;
  let batch: string[] = [];
  const sweep = async () => {
    const ids = batch.map((k) => k.slice(k.lastIndexOf('/') + 1));
    const known = new Set(
      (
        await db.fileBlob.findMany({
          where: { storageKey: { in: batch } },
          select: { storageKey: true },
        })
      ).map((b) => b.storageKey),
    );
    for (const [i, k] of batch.entries())
      if (!known.has(k) && /^[0-9a-f-]{36}$/.test(ids[i]!)) {
        await storage.delete(k);
        deleted++;
      }
    batch = [];
  };
  for await (const o of storage.list('blobs/')) {
    if (o.modifiedAt >= cutoff) continue;
    batch.push(o.key);
    if (batch.length >= 500) await sweep();
  }
  if (batch.length) await sweep();
  return deleted;
}

/** Deletes blobs no File/FileVariant references, older than the grace period. */
export async function garbageCollectBlobs(db: Db, olderThanMs = 24 * 3600_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const orphans = await db.fileBlob.findMany({
    where: { createdAt: { lt: cutoff }, files: { none: {} }, variants: { none: {} } },
    take: 500,
  });
  let deleted = 0;
  for (const b of orphans) {
    // The row goes first and only if still unreferenced: an upload of the same content may
    // have reused the blob since the query above. Only then is the stored object removed.
    const r = await db.fileBlob.deleteMany({
      where: { id: b.id, files: { none: {} }, variants: { none: {} } },
    });
    if (!r.count) continue;
    await getStorage()
      .delete(b.storageKey)
      .catch((e) =>
        logger.warn({ err: e, storageKey: b.storageKey }, 'could not delete a stored blob'),
      );
    deleted++;
  }
  return deleted;
}

export function fileUrl(file: Pick<File, 'id' | 'name'>): string {
  return `/files/${file.id}/${encodeURIComponent(file.name)}`;
}

// Core areas
registerFileArea('site', 'branding', async () => true);
registerFileArea('user', 'avatar', async (ctx) => ctx.actor.kind !== 'anonymous');

export const BRANDING_CONTEXT = SYSTEM_CONTEXT_ID;
