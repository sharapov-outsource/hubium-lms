import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { archiveTempDir, ValidationError } from '@hubium/core';
import { msg } from '@hubium/module-sdk';
import { extractZip, PackageLimitError, safeEntryPath } from '@hubium/module-sdk/zip';
import tar from 'tar-stream';

// Uploaded archives are untrusted: a few megabytes can expand into gigabytes, and the sizes
// in their headers can lie. An archive is unpacked as a stream to a folder of its own on
// disk, counting the bytes that actually come out, and its files are read one at a time.

export interface ArchiveLimits {
  /** Total uncompressed bytes, as they come out. */
  bytes: number;
  entries: number;
  /** Uncompressed to compressed: per file of a zip, over the whole of a .tar.gz. */
  ratio: number;
}

export const ARCHIVE_LIMITS: ArchiveLimits = {
  bytes: 8 * 1024 ** 3,
  entries: 100_000,
  ratio: 200,
};

/** One file is read into memory at a time; Node reads at most this much at once. */
const FILE_MAX = 2 * 1024 ** 3 - 1;
/** Below this, a .tar.gz is not held to the ratio: small archives of text pack tightly. */
const RATIO_FROM = 100 * 1024 ** 2;

export const archiveTooLarge = () =>
  new ValidationError({ file: [msg('errors.interchange.archiveTooLarge')] });
const archiveDamaged = () =>
  new ValidationError({ file: [msg('errors.interchange.archiveDamaged')] });

/** The files of an unpacked archive, by their path in it. */
export interface ArchiveFiles {
  has(name: string): boolean;
  /** The file's bytes; undefined when the archive has no such file. */
  get(name: string): Buffer | undefined;
  names(): string[];
  /** Removes the unpacked files. */
  close(): Promise<void>;
}

/** Counts the bytes going through; throws (failing the stream) past the limits. */
const meter = (add: (n: number) => void) =>
  new Transform({
    transform(chunk: Buffer, _enc, done) {
      try {
        add(chunk.length);
        done(null, chunk);
      } catch (e) {
        done(e as Error);
      }
    },
  });

/**
 * Unpacks a zip, a .tar.gz or a tar (a file on disk, or bytes) to a folder of its own.
 * Throws a ValidationError when it is past the limits, or `unreadable` when it is damaged,
 * unsafe or no archive at all.
 */
export async function openArchive(
  source: string | Uint8Array,
  limits: ArchiveLimits = ARCHIVE_LIMITS,
  unreadable: () => ValidationError = archiveDamaged,
): Promise<ArchiveFiles> {
  await mkdir(archiveTempDir(), { recursive: true });
  const dir = await mkdtemp(path.join(archiveTempDir(), 'import-'));
  const files = new Map<string, string>();
  try {
    const file = typeof source === 'string' ? source : path.join(dir, 'archive');
    if (typeof source !== 'string') await writeFile(file, source);
    const head = Buffer.alloc(2);
    const fh = await open(file);
    await fh.read(head, 0, 2, 0).finally(() => fh.close());
    let total = 0;
    let n = 0;
    // each file goes to a numbered file of the folder: no name in the archive becomes a path
    const save = async (name: string, stream: Readable, add?: (n: number) => void) => {
      const to = path.join(dir, `f${n++}`);
      await (add
        ? pipeline(stream, meter(add), createWriteStream(to))
        : pipeline(stream, createWriteStream(to)));
      files.set(name, to);
    };
    if (head[0] === 0x50 && head[1] === 0x4b) {
      // yauzl checks each file's bytes against its header, which the limits use
      await extractZip(
        file,
        async (name, stream, size) => {
          if (size > FILE_MAX) throw archiveTooLarge();
          await save(name, stream);
        },
        { maxEntries: limits.entries, maxTotalBytes: limits.bytes, maxRatio: limits.ratio },
      );
    } else {
      const gz = head[0] === 0x1f && head[1] === 0x8b;
      const packed = (await stat(file)).size;
      const cap = gz
        ? Math.min(limits.bytes, Math.max(RATIO_FROM, packed * limits.ratio))
        : limits.bytes;
      const extract = tar.extract();
      let count = 0;
      extract.on('entry', (header, stream, next) => {
        // the archive's error is the one reported; the entry's own would go unheard
        stream.on('error', () => {});
        const fail = (e: unknown) => extract.destroy(e as Error);
        if (++count > limits.entries) return fail(archiveTooLarge());
        if (header.type !== 'file') {
          // folders and links are not files of the archive
          stream.on('end', () => next());
          stream.resume();
          return;
        }
        const name = safeEntryPath(header.name);
        if (!name) return fail(unreadable());
        let size = 0;
        save(name, stream as unknown as Readable, (k) => {
          size += k;
          total += k;
          if (size > FILE_MAX || total > cap) throw archiveTooLarge();
        }).then(() => next(), fail);
      });
      await (gz
        ? pipeline(createReadStream(file), createGunzip(), extract)
        : pipeline(createReadStream(file), extract));
    }
    if (typeof source !== 'string') await rm(file, { force: true });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    if (e instanceof ValidationError) throw e;
    if (e instanceof PackageLimitError) throw archiveTooLarge();
    throw unreadable();
  }
  return {
    has: (name) => files.has(name),
    get: (name) => {
      const f = files.get(name);
      return f ? readFileSync(f) : undefined;
    },
    names: () => [...files.keys()],
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Opens an archive, hands it to `use` and removes the unpacked files afterwards. */
export async function withArchive<T>(
  source: string | Uint8Array,
  use: (a: ArchiveFiles) => T | Promise<T>,
  limits?: ArchiveLimits,
  unreadable?: () => ValidationError,
): Promise<T> {
  const a = await openArchive(source, limits, unreadable);
  try {
    return await use(a);
  } finally {
    await a.close();
  }
}
