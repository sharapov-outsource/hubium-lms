import { buffer } from 'node:stream/consumers';
import { documentKind, extractDocumentText } from '@hubium/ai/extract';
import type { Db, Prisma } from '@hubium/db';
import { getStorage } from './storage.ts';

// Text of uploaded documents for the AI tutor, quiz generation and search. Extraction runs
// in the worker while it re-indexes an activity; the result is kept per blob, so copies of
// a file (course duplication, restore) and later re-indexing reuse it.

/** Raised when extraction changes; cached texts of older versions are extracted again. */
export const FILE_TEXT_VERSION = 1;

/** Larger files are not read (the text layer of a bigger PDF is rarely worth the memory). */
export const FILE_TEXT_MAX_BYTES = 50 * 1024 * 1024;

/** Whether `fileText` reads this file at all. */
export function isTextDocument(file: { name: string; mimeType: string; size: number | bigint }) {
  return !!documentKind(file.name, file.mimeType) && Number(file.size) <= FILE_TEXT_MAX_BYTES;
}

/**
 * Plain text of a document file (PDF, DOCX, PPTX, ODT, ODP, text, HTML); null for other
 * files, oversized ones and documents that could not be read.
 */
export async function fileText(
  db: Db | Prisma.TransactionClient,
  fileId: string,
): Promise<string | null> {
  const f = await db.file.findUnique({
    where: { id: fileId },
    include: { blob: { include: { text: true } } },
  });
  if (!f || !isTextDocument(f)) return null;
  const cached = f.blob.text;
  if (cached?.version === FILE_TEXT_VERSION) return cached.error ? null : cached.text;

  let text = '';
  let truncated = false;
  let error: string | null = null;
  try {
    const data = await buffer(await getStorage().getStream(f.blob.storageKey));
    const r = await extractDocumentText(data, { name: f.name, mimeType: f.mimeType });
    text = r?.text ?? '';
    truncated = r?.truncated ?? false;
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500) || 'Unreadable document';
  }
  const row = { version: FILE_TEXT_VERSION, text, truncated, error };
  await db.fileBlobText.upsert({
    where: { blobId: f.blobId },
    create: { blobId: f.blobId, ...row },
    update: { ...row, createdAt: new Date() },
  });
  return error ? null : text;
}
