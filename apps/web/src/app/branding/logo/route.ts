import { getAllSettings } from '@hubium/core';
import { db } from '@/server/db';
import { serveFile } from '@/server/lib/serve-file';

export const dynamic = 'force-dynamic';

export async function GET() {
  const id = (await getAllSettings(db))['branding.logoFileId'];
  const file = id ? await db.file.findUnique({ where: { id }, include: { blob: true } }) : null;
  if (!file) return new Response('Not found', { status: 404 });
  return serveFile(file, { cache: 'public, max-age=60' });
}
