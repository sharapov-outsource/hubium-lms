import { appendFile, mkdir, rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import type { Db, Prisma } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { checkFileFromPath } from './files.ts';
import { fsStorageRoot } from './storage.ts';

// Resumable uploads (tus-like): the client creates a session, appends chunks at the
// current offset and resumes from `received` after a network failure. Chunks are kept
// on local disk until a module consumes the upload into a File.

type Tx = Prisma.TransactionClient | Db;

export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const TTL_MS = 24 * 3600_000;

export function uploadTempDir(): string {
  return path.join(fsStorageRoot(), 'tmp', 'uploads');
}

function tempPath(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id))
    throw new ValidationError({ id: [msg('errors.files.badUploadId')] });
  return path.join(uploadTempDir(), id);
}

/** Unfinished uploads one user may hold at a time (they occupy the server's disk). */
export const UPLOAD_PENDING_MAX_BYTES = 2 * UPLOAD_MAX_BYTES;
export const UPLOAD_PENDING_MAX_COUNT = 20;

export async function createUpload(
  db: Tx,
  userId: string,
  input: { name: string; size: number; mimeType?: string },
) {
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > UPLOAD_MAX_BYTES) {
    throw new ValidationError({ size: [msg('errors.files.badSize')] });
  }
  const pending = await db.uploadSession.aggregate({
    where: { userId, completedAt: null, expiresAt: { gt: new Date() } },
    _sum: { size: true },
    _count: { _all: true },
  });
  if (
    pending._count._all >= UPLOAD_PENDING_MAX_COUNT ||
    Number(pending._sum.size ?? 0n) + input.size > UPLOAD_PENDING_MAX_BYTES
  )
    throw new ValidationError({ size: [msg('errors.files.tooManyUploads')] });
  const s = await db.uploadSession.create({
    data: {
      userId,
      name: input.name.slice(0, 255),
      size: BigInt(input.size),
      mimeType: input.mimeType || 'application/octet-stream',
      storageKey: `uploads/${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
  await mkdir(uploadTempDir(), { recursive: true });
  await appendFile(tempPath(s.id), Buffer.alloc(0));
  return { id: s.id, chunkSize: UPLOAD_CHUNK_BYTES, received: 0 };
}

async function own(db: Tx, userId: string, id: string) {
  const s = await db.uploadSession.findUnique({ where: { id } });
  if (!s || s.expiresAt < new Date()) throw new NotFoundError('Upload');
  if (s.userId !== userId) throw new ForbiddenError();
  return s;
}

export async function getUpload(db: Tx, userId: string, id: string) {
  const s = await own(db, userId, id);
  return { id: s.id, size: Number(s.size), received: Number(s.received), done: !!s.completedAt };
}

/** Appends a chunk at `offset`. A mismatched offset returns the server's position. */
export async function appendUploadChunk(
  db: Tx,
  userId: string,
  id: string,
  offset: number,
  chunk: Buffer,
): Promise<{ received: number; conflict?: boolean }> {
  const s = await own(db, userId, id);
  if (s.completedAt) throw new ValidationError({ id: [msg('errors.files.uploadComplete')] });
  const received = Number(s.received);
  // A request that died half-way leaves disk and database apart: the database never
  // runs ahead of the disk, and bytes past it are dropped.
  const onDisk = await stat(tempPath(id)).then(
    (x) => x.size,
    () => 0,
  );
  if (onDisk > received) await truncate(tempPath(id), received);
  if (onDisk < received) {
    await db.uploadSession.update({ where: { id }, data: { received: BigInt(onDisk) } });
    return { received: onDisk, conflict: true };
  }
  if (offset !== received) return { received, conflict: true };
  if (chunk.length > UPLOAD_CHUNK_BYTES * 2 || received + chunk.length > Number(s.size)) {
    throw new ValidationError({ chunk: [msg('errors.files.chunkTooLarge')] });
  }
  // Claim the offset first so a retried request racing the original cannot append twice.
  const next = received + chunk.length;
  const claim = await db.uploadSession.updateMany({
    where: { id, received: s.received },
    data: { received: BigInt(next) },
  });
  if (!claim.count)
    return { received: Number((await own(db, userId, id)).received), conflict: true };
  try {
    await appendFile(tempPath(id), chunk);
  } catch (e) {
    await db.uploadSession.updateMany({
      where: { id, received: BigInt(next) },
      data: { received: s.received },
    });
    throw e;
  }
  return { received: next };
}

/** An upload of this user that is finished and not used yet. */
async function finished(db: Tx, userId: string, id: string) {
  const s = await own(db, userId, id);
  if (s.completedAt) throw new ValidationError({ id: [msg('errors.files.uploadUsed')] });
  if (s.received !== s.size)
    throw new ValidationError({ id: [msg('errors.files.uploadIncomplete')] });
  return s;
}

/**
 * Everything storing a finished upload checks (size, type, malware), done before what it
 * belongs to is made, as checkFile does for a file sent with a form.
 */
export async function checkUpload(
  db: Tx,
  userId: string,
  id: string,
  opts: { maxBytes?: number; allowedTypes?: RegExp } = {},
): Promise<void> {
  const s = await finished(db, userId, id);
  await checkFileFromPath(db, {
    filePath: tempPath(id),
    name: s.name,
    mimeType: s.mimeType,
    ...opts,
  });
}

/** Hands a finished upload to a consumer; the temp file is removed afterwards. */
export async function consumeUpload<T>(
  db: Tx,
  userId: string,
  id: string,
  use: (file: { path: string; name: string; mimeType: string; size: number }) => Promise<T>,
): Promise<T> {
  const s = await finished(db, userId, id);
  const out = await use({
    path: tempPath(id),
    name: s.name,
    mimeType: s.mimeType,
    size: Number(s.size),
  });
  await db.uploadSession.update({ where: { id }, data: { completedAt: new Date() } });
  await rm(tempPath(id), { force: true });
  return out;
}

/** Cron: drops expired sessions and their temp files. */
export async function cleanupUploads(
  db: Db,
  now = new Date(),
  budgetMs = 10 * 60_000,
): Promise<number> {
  const until = Date.now() + budgetMs;
  let removed = 0;
  // 500 at a time until none are left or the time is up
  while (Date.now() < until) {
    const old = await db.uploadSession.findMany({
      where: { OR: [{ expiresAt: { lt: now } }, { completedAt: { not: null } }] },
      select: { id: true },
      take: 500,
    });
    for (const u of old) await rm(tempPath(u.id), { force: true });
    await db.uploadSession.deleteMany({ where: { id: { in: old.map((u) => u.id) } } });
    removed += old.length;
    if (old.length < 500) break;
  }
  return removed;
}
