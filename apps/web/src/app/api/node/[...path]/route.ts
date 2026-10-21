import { handleNodeApi } from '@hubium/core/node/api';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The node API: what the agents of local nodes call (packages/core/src/node/api.ts). */
async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return handleNodeApi(db, req, (await params).path);
}

export { handle as GET, handle as POST, handle as PUT };
