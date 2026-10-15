import { gunzipSync } from 'node:zlib';
import { ValidationError } from '@hubium/core';
import { msg } from '@hubium/module-sdk';
import { unzipSync } from 'fflate';

// Uploaded archives are untrusted: a few megabytes can expand into gigabytes. Everything is
// unpacked in memory, so the uncompressed size and the number of entries are capped.

export interface ArchiveLimits {
  /** Total uncompressed bytes. */
  bytes: number;
  entries: number;
}

export const ARCHIVE_LIMITS: ArchiveLimits = { bytes: 2 * 1024 * 1024 * 1024, entries: 100_000 };

export const archiveTooLarge = () =>
  new ValidationError({ file: [msg('errors.interchange.archiveTooLarge')] });

/** Unzips with fflate; sizes come from the headers, which also bound the output buffers. */
export function unzipLimited(
  data: Uint8Array,
  limits: ArchiveLimits = ARCHIVE_LIMITS,
): Record<string, Uint8Array> {
  let total = 0;
  let count = 0;
  return unzipSync(data, {
    filter(f) {
      total += Math.max(f.size, f.originalSize);
      if (++count > limits.entries || total > limits.bytes) throw archiveTooLarge();
      return true;
    },
  });
}

export function gunzipLimited(data: Buffer, limits: ArchiveLimits = ARCHIVE_LIMITS): Buffer {
  try {
    return gunzipSync(data, { maxOutputLength: limits.bytes });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw archiveTooLarge();
    throw new ValidationError({ file: [msg('errors.interchange.archiveDamaged')] });
  }
}
