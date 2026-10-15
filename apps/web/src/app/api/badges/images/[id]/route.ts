import { badgeImage } from '@hubium/core';
import { db } from '@/server/db';
import { serveFile } from '@/server/lib/serve-file';

export const dynamic = 'force-dynamic';

/** A badge class's image, public as the badge class is. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = /^[0-9a-f-]{36}$/.test(id) ? await badgeImage(db, id) : null;
  if (!file) return new Response('Not found', { status: 404 });
  return serveFile(file, { cache: 'public, max-age=300' });
}
