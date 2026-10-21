import { canReadFile } from '@hubium/core/files/files';
import { db } from '@/server/db';
import { serveFile } from '@/server/lib/serve-file';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return new Response('Not found', { status: 404 });
  const file = await db.file.findUnique({ where: { id: fileId }, include: { blob: true } });
  if (!file) return new Response('Not found', { status: 404 });
  const ctx = await getContext();
  if (!(await canReadFile(ctx, file))) {
    return new Response('Forbidden', { status: ctx.actor.kind === 'anonymous' ? 401 : 403 });
  }
  const download = new URL(req.url).searchParams.has('download');
  return serveFile(file, { download, range: req.headers.get('range') });
}
