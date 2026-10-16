import 'server-only';
import { readFile } from 'node:fs/promises';
import { consumeUpload } from '@hubium/core/files/uploads';
import { UPLOAD_SUFFIX } from '@/lib/form-uploads';
import { db } from './db';
import { getCurrentUser } from './session';

/** A file of a form: sent with it, or uploaded ahead of it (see lib/form-uploads.ts). */
export type FormFile = { field: string } & (
  | { file: File; uploadId?: undefined }
  | { uploadId: string; file?: undefined }
);

/** The form's files of the fields `keep` takes, in the form's order. */
export function formFiles(fd: FormData, keep: (field: string) => boolean): FormFile[] {
  const out: FormFile[] = [];
  for (const [k, v] of fd.entries()) {
    if (k.endsWith(UPLOAD_SUFFIX) && typeof v === 'string' && v) {
      const field = k.slice(0, -UPLOAD_SUFFIX.length);
      if (keep(field)) out.push({ field, uploadId: v });
    } else if (v instanceof File && v.size > 0 && keep(k)) out.push({ field: k, file: v });
  }
  return out;
}

/**
 * The file of a form's `field`, whether it came with the form or, too large for it, was
 * uploaded ahead (lib/form-uploads.ts); null when none was chosen. For forms that read the
 * file whole (a picture, a spreadsheet, a language pack): an upload is read and removed.
 */
export async function formFile(fd: FormData, field: string): Promise<File | null> {
  const sent = fd.get(field);
  if (sent instanceof File && sent.size > 0) return sent;
  const id = fd.get(`${field}${UPLOAD_SUFFIX}`);
  if (typeof id !== 'string' || !id) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  return consumeUpload(
    db,
    user.id,
    id,
    async (u) => new File([await readFile(u.path)], u.name, { type: u.mimeType }),
  );
}
