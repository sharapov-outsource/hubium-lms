import 'server-only';
import { UPLOAD_SUFFIX } from '@/lib/form-uploads';

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
