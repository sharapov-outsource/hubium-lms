import { exportUserData } from '@hubium/core';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** "Download my data": everything stored about the signed-in user, as JSON. */
export async function GET() {
  const ctx = await getContext();
  if (ctx.actor.kind !== 'user') return new Response('Unauthorized', { status: 401 });
  const data = await exportUserData(ctx, ctx.actor.userId);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="hubium-my-data-${date}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
