import 'server-only';
import { Readable } from 'node:stream';
import { normalizeMimeType, servesInline } from '@hubium/core/files/files';
import { getStorage } from '@hubium/core/files/storage';
import type { File, FileBlob } from '@hubium/db';

/** Streams (FS) or redirects to a presigned URL (S3). Unsafe types always download. */
export async function serveFile(
  file: File & { blob: FileBlob },
  opts: { download?: boolean; cache?: string } = {},
) {
  const storage = getStorage();
  // Older rows may hold a raw client-declared type: never serve anything but a clean one.
  const mime = normalizeMimeType(file.mimeType);
  if (storage.kind === 's3') {
    // straight from the bucket: no sandbox CSP comes with it, so no SVG opens inline
    const url = await storage.signedReadUrl(file.blob.storageKey, {
      ttlSeconds: 60,
      filename: file.name,
      inline: !opts.download && servesInline(mime, { sandboxed: false }),
      contentType: mime,
    });
    return Response.redirect(url, 302);
  }
  const inline = !opts.download && servesInline(mime, { sandboxed: true });
  const stream = await storage.getStream(file.blob.storageKey);
  const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Length': String(file.size),
    'Content-Disposition': disposition,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': opts.cache ?? 'private, max-age=300',
  };
  // User content never runs as part of the LMS; PDFs keep the browser viewer working.
  if (mime !== 'application/pdf')
    headers['Content-Security-Policy'] =
      "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
  return new Response(Readable.toWeb(stream as Readable) as ReadableStream, { headers });
}
