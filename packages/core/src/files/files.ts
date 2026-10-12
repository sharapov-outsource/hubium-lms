import { createHash } from 'node:crypto';
import { type Db, type File, type Prisma, SYSTEM_CONTEXT_ID, uuidv7 } from '@hubium/db';
import type { RequestContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { getStorage } from './storage.ts';

type Tx = Prisma.TransactionClient | Db;

// File service. A File row addresses (context, component, area, itemId, path, name) and
// points to an immutable FileBlob; copying a course copies rows, not bytes.

export type FileAccessCheck = (ctx: RequestContext, file: File) => Promise<boolean>;
const areaAccess = new Map<string, FileAccessCheck>();

/** Registers who may read files of a component/area. Unregistered areas are denied. */
export function registerFileArea(component: string, area: string, check: FileAccessCheck): void {
  areaAccess.set(`${component}/${area}`, check);
}

export async function canReadFile(ctx: RequestContext, file: File): Promise<boolean> {
  if (file.status !== 'READY') return false;
  const check = areaAccess.get(`${file.component}/${file.area}`);
  if (!check) return ctx.perm.isSiteAdmin;
  return check(ctx, file);
}

const SIGNATURES: [string, number[]][] = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
  ['application/zip', [0x50, 0x4b, 0x03, 0x04]],
];

/** Sniffs the real type of common formats; falls back to the declared type. */
export function sniffMimeType(data: Buffer, declared: string, name: string): string {
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
  return /^(image\/(png|jpeg|gif|webp|svg\+xml)|application\/pdf|video\/|audio\/|text\/plain|text\/vtt)/.test(
    mime,
  );
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

export async function storeFile(db: Tx, input: StoreFileInput): Promise<File> {
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
  let blob = await db.fileBlob.findFirst({ where: { sha256, size: input.data.length } });
  if (!blob) {
    const id = uuidv7();
    const storageKey = `blobs/${id.slice(-2)}/${id}`;
    await getStorage().put(storageKey, input.data, mimeType);
    blob = await db.fileBlob.create({
      data: { id, storageKey, size: input.data.length, mimeType, sha256 },
    });
  }
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

export async function listFiles(
  db: Tx,
  q: { contextId: string; component: string; area: string; itemId?: string },
): Promise<File[]> {
  return db.file.findMany({
    where: { contextId: q.contextId, component: q.component, area: q.area, itemId: q.itemId ?? '' },
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

/** Deletes blobs no File/FileVariant references, older than the grace period. */
export async function garbageCollectBlobs(db: Db, olderThanMs = 24 * 3600_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const orphans = await db.fileBlob.findMany({
    where: { createdAt: { lt: cutoff }, files: { none: {} }, variants: { none: {} } },
    take: 500,
  });
  for (const b of orphans) {
    await getStorage().delete(b.storageKey);
    await db.fileBlob.delete({ where: { id: b.id } });
  }
  return orphans.length;
}

export function fileUrl(file: Pick<File, 'id' | 'name'>): string {
  return `/files/${file.id}/${encodeURIComponent(file.name)}`;
}

// Core areas
registerFileArea('site', 'branding', async () => true);
registerFileArea('user', 'avatar', async (ctx) => ctx.actor.kind !== 'anonymous');

export const BRANDING_CONTEXT = SYSTEM_CONTEXT_ID;
