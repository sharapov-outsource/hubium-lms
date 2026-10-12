import 'server-only';
import { Readable } from 'node:stream';
import { isInlineSafe } from '@hubium/core/files/files';
import { getStorage } from '@hubium/core/files/storage';
import type { File, FileBlob } from '@hubium/db';

/** Streams (FS) or redirects to a presigned URL (S3). Unsafe types always download. */
export async function serveFile(
  file: File & { blob: FileBlob },
  opts: { download?: boolean; cache?: string } = {},
) {
  const storage = getStorage();
  const inline = !opts.download && isInlineSafe(file.mimeType);
  if (storage.kind === 's3') {
    const url = await storage.signedReadUrl(file.blob.storageKey, {
      ttlSeconds: 60,
      filename: file.name,
      inline,
    });
    return Response.redirect(url, 302);
  }
  const stream = await storage.getStream(file.blob.storageKey);
  const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  const headers: Record<string, string> = {
    'Content-Type': file.mimeType,
    'Content-Length': String(file.size),
    'Content-Disposition': disposition,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': opts.cache ?? 'private, max-age=300',
  };
  if (file.mimeType === 'image/svg+xml')
    headers['Content-Security-Policy'] = 'sandbox; default-src none; style-src unsafe-inline';
  return new Response(Readable.toWeb(stream as Readable) as ReadableStream, { headers });
}
