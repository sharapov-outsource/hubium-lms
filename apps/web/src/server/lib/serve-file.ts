import 'server-only';
import { Readable } from 'node:stream';
import { normalizeMimeType, servesInline } from '@hubium/core/files/files';
import { getStorage } from '@hubium/core/files/storage';
import type { File, FileBlob } from '@hubium/db';

/**
 * The part of a file an HTTP Range header asks for (`bytes=start-end`, `bytes=start-`,
 * `bytes=-suffix`); null for the whole file, 'invalid' when it lies outside the file.
 */
export function byteRange(header: string | null, size: number) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? ('invalid' as const) : { start, end };
}

/**
 * Streams (FS, and the mirror of a local node) or redirects to a presigned URL (S3), a part
 * when the request asks for a range (seeking in a video). Unsafe types always download.
 */
export async function serveFile(
  file: File & { blob: FileBlob },
  opts: { download?: boolean; cache?: string; range?: string | null } = {},
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
  const size = Number(file.size);
  const range = byteRange(opts.range ?? null, size);
  if (range === 'invalid')
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const stream = await storage.getStream(file.blob.storageKey, range ?? undefined);
  const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Length': String(range ? range.end - range.start + 1 : size),
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': opts.cache ?? 'private, max-age=300',
  };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  // User content never runs as part of the LMS; PDFs keep the browser viewer working.
  if (mime !== 'application/pdf')
    headers['Content-Security-Policy'] =
      "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
  return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
}
