// Files too large for a server action's body (10 MB, next.config.ts) go ahead of the form
// through the resumable uploads (/api/uploads): the form then carries `<field>::upload`
// with the upload's id in place of the file.

import { uploadResumable } from '@hubium/module-sdk/form';

export const UPLOAD_SUFFIX = '::upload';

/** What a form may carry with its files and still fit a server action's body. */
const ACTION_BODY = 9 * 1024 * 1024;

/** The form, its largest files uploaded ahead until the rest fits a server action. */
export async function withUploads(fd: FormData): Promise<FormData> {
  const files = [...fd.entries()].filter(
    (e): e is [string, File] => e[1] instanceof File && e[1].size > 0,
  );
  let total = files.reduce((n, [, f]) => n + f.size, 0);
  if (total <= ACTION_BODY) return fd;
  const ahead = new Set<File>();
  for (const [, f] of [...files].sort((a, b) => b[1].size - a[1].size)) {
    if (total <= ACTION_BODY) break;
    ahead.add(f);
    total -= f.size;
  }
  const out = new FormData();
  for (const [k, v] of fd.entries())
    if (v instanceof File && ahead.has(v))
      out.append(`${k}${UPLOAD_SUFFIX}`, await uploadResumable(v));
    else out.append(k, v);
  return out;
}
