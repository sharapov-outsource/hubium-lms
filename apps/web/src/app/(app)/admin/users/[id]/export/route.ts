import { exportUserData } from '@hubium/core';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Admin: personal data export for a data subject request. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('user:update').catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  const data = await exportUserData(ctx, id);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="hubium-user-${id}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
