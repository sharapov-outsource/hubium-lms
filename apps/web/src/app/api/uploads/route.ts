import { createUpload, toActionError } from '@hubium/core';
import { db } from '@/server/db';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Starts a resumable upload: { name, size, mimeType } → { id, chunkSize, received }. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ message: 'Sign in' }, { status: 401 });
  try {
    const body = (await req.json()) as { name?: string; size?: number; mimeType?: string };
    return Response.json(
      await createUpload(db, session.user.id, {
        name: String(body.name ?? 'file'),
        size: Number(body.size),
        mimeType: body.mimeType,
      }),
    );
  } catch (e) {
    return Response.json(toActionError(e), { status: 400 });
  }
}
