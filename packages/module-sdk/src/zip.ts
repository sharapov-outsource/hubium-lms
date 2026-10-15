import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { PermanentJobError } from './index.ts';

// Unpacking packages that modules serve (SCORM, H5P): every file streamed out of a zip,
// with zip-slip and zip-bomb limits, and the content type of a packaged file.

export interface ExtractLimits {
  maxEntries: number;
  maxTotalBytes: number;
  /** Max uncompressed/compressed ratio for entries over 1 MB. */
  maxRatio: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxEntries: 20_000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxRatio: 200,
};

/** Normalises a zip entry name; null when it escapes the root or is not a regular path. */
export function safeEntryPath(name: string): string | null {
  const p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\u0000-\u001f]/.test(seg)) return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** A package past a limit of `extractZip`: too many files, too large unpacked, or packed
 *  suspiciously tightly. */
export class PackageLimitError extends Error {
  override name = 'PackageLimitError';
}

const unsafe = (e: Error) =>
  /invalid relative path|absolute path/i.test(e.message)
    ? new Error(`Unsafe path in the package: ${e.message}`)
    : e;

/** Streams every file of the zip to `onFile`; rejects unsafe archives. */
export function extractZip(
  zipPath: string,
  onFile: (path: string, stream: Readable, size: number) => Promise<void>,
  limits: ExtractLimits = DEFAULT_LIMITS,
): Promise<{ files: string[]; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: false },
      (err, zip) => {
        if (err || !zip) return reject(unsafe(err ?? new Error('Cannot open zip')));
        const files: string[] = [];
        let total = 0;
        const fail = (e: Error) => {
          zip.close();
          reject(unsafe(e));
        };
        zip.on('error', fail);
        zip.on('end', () => resolve({ files, totalBytes: total }));
        zip.on('entry', (entry: yauzl.Entry) => {
          if (entry.fileName.endsWith('/')) return zip.readEntry();
          if (files.length >= limits.maxEntries)
            return fail(new PackageLimitError('Too many files in the package'));
          const path = safeEntryPath(entry.fileName);
          if (!path) return fail(new Error(`Unsafe path in the package: ${entry.fileName}`));
          // unix mode in the high bits: reject symlinks
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000)
            return fail(new Error(`Symbolic link in the package: ${entry.fileName}`));
          total += entry.uncompressedSize;
          if (total > limits.maxTotalBytes)
            return fail(new PackageLimitError('The package is too large when unpacked'));
          if (
            entry.uncompressedSize > 1024 * 1024 &&
            entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxRatio
          ) {
            return fail(new PackageLimitError(`Suspicious compression ratio: ${entry.fileName}`));
          }
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return fail(e ?? new Error('Cannot read entry'));
            onFile(path, stream, entry.uncompressedSize)
              .then(() => {
                files.push(path);
                zip.readEntry();
              })
              .catch(fail);
          });
        });
        zip.readEntry();
      },
    );
  });
}

/** The content type a packaged file is served with. */
export function contentTypeFor(file: string): string {
  const ext = file.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json',
    xml: 'application/xml',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    webm: 'video/webm',
    vtt: 'text/vtt',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
    swf: 'application/x-shockwave-flash',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** An error of storage while a package is unpacked: passing, so the job is tried again,
 *  unlike what the package itself is. */
export class StorageFailure extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StorageFailure';
  }
}

/** A storage write whose failure is told apart from the package's (see StorageFailure). */
export const stored = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new StorageFailure(e);
  });

/** What is wrong with the package: the job ends without trying again. */
export const permanent = (e: unknown) =>
  new PermanentJobError(e instanceof Error ? e.message : String(e), { cause: e });
