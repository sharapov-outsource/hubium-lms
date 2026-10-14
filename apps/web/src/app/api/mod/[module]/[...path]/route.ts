import { buildModuleCtx, getAllSettings, getModule, isModuleEnabled } from '@hubium/core';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Dispatches /api/mod/<module>/<...path> to `ActivityModule.http`. */
async function handle(
  req: Request,
  { params }: { params: Promise<{ module: string; path: string[] }> },
) {
  const { module, path } = await params;
  const m = getModule(module);
  if (!m?.http || !isModuleEnabled(await getAllSettings(db), m.key))
    return new Response('Not found', { status: 404 });
  const ctx = await getContext();
  return m.http(buildModuleCtx(ctx), req, path);
}

export { handle as GET, handle as POST };
