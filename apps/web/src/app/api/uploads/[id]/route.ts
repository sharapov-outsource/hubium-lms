import { appendUploadChunk, getUpload, toActionError } from '@hubium/core';
import { db } from '@/server/db';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Current offset, so an interrupted upload resumes where it stopped. */
export async function GET(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return Response.json({ message: 'Sign in' }, { status: 401 });
  try {
    return Response.json(await getUpload(db, session.user.id, (await params).id));
  } catch (e) {
    return Response.json(toActionError(e), { status: 404 });
  }
}

/** Appends a chunk; `Upload-Offset` must equal the bytes already received (else 409). */
export async function PATCH(req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return Response.json({ message: 'Sign in' }, { status: 401 });
  try {
    const offset = Number(req.headers.get('upload-offset'));
    const chunk = Buffer.from(await req.arrayBuffer());
    const r = await appendUploadChunk(db, session.user.id, (await params).id, offset, chunk);
    return Response.json(r, { status: r.conflict ? 409 : 200 });
  } catch (e) {
    return Response.json(toActionError(e), { status: 400 });
  }
}
