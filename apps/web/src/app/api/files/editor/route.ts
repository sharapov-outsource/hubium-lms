import { isAppError, ValidationError } from '@hubium/core/errors';
import { fileUrl, storeFile } from '@hubium/core/files/files';
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
  try {
    const f = await storeFile(db, {
      contextId: courseId,
      component: 'course',
      area: 'editor',
      path: `/${Date.now()}/`,
      name: file.name,
      mimeType: file.type,
      data: Buffer.from(await file.arrayBuffer()),
      uploadedById: ctx.perm.userId,
      maxBytes: 10 * 1024 * 1024,
      allowedTypes: /^image\/(png|jpeg|gif|webp)$/,
    });
    return Response.json({ url: fileUrl(f) });
  } catch (e) {
    // a rejected file (size, type, malware) is 422; an unreachable virus scanner is 503
    if (e instanceof ValidationError)
      return new Response(
        Object.values(e.fieldErrors ?? {})
          .flat()
          .join('; ') || e.message,
        {
          status: 422,
        },
      );
    if (isAppError(e)) return new Response(e.message, { status: e.status });
    throw e;
  }
}
