import { EDITOR_IMAGE, storeEditorImage } from '@hubium/core';
import { describeError, isAppError, ValidationError } from '@hubium/core/errors';
import { checkFile } from '@hubium/core/files/files';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Image upload from the rich text editor; stored in the course "editor" area. */
export async function POST(req: Request) {
  const ctx = await getContext();
  const courseId = new URL(req.url).searchParams.get('courseId') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(courseId)) return new Response('Bad request', { status: 400 });
  if (!(await ctx.perm.can('course:manageactivities', courseId)))
    return new Response('Forbidden', { status: 403 });
  const fd = await req.formData();
  const file = fd.get('file');
  if (!(file instanceof File)) return new Response('No file', { status: 400 });
  const image = {
    name: file.name,
    mimeType: file.type,
    data: Buffer.from(await file.arrayBuffer()),
  };
  try {
    // size, type and malware are checked before the transaction opens
    await checkFile(db, { ...image, ...EDITOR_IMAGE });
    return Response.json(await storeEditorImage.run(ctx, { courseId, ...image }));
  } catch (e) {
    // a rejected file (size, type, malware) is 422; an unreachable virus scanner is 503
    if (e instanceof ValidationError)
      return new Response(describeError(e, ctx.locale), { status: 422 });
    if (isAppError(e)) return new Response(describeError(e, ctx.locale), { status: e.status });
    throw e;
  }
}
