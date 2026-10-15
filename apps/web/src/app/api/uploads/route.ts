import { createUpload, toActionError } from '@hubium/core';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

const signInFirst = async () =>
  Response.json(
    {
      ok: false,
      code: 'UNAUTHENTICATED',
      message: (await getTranslations('errors'))('UNAUTHENTICATED'),
    },
    { status: 401 },
  );

/** Starts a resumable upload: { name, size, mimeType } → { id, chunkSize, received }. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return signInFirst();
  const locale = await getLocale();
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
    return Response.json(toActionError(e, locale), { status: 400 });
  }
}
