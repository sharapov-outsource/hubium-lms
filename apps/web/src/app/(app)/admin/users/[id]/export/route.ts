import { exportUserData, ForbiddenError, NotFoundError } from '@hubium/core';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Admin: personal data export for a data subject request. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const ctx = await getContext();
  if (!(await ctx.perm.can('user:update').catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  let data: Awaited<ReturnType<typeof exportUserData>>;
  try {
    data = await exportUserData(ctx, id);
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response('Forbidden', { status: 403 });
    if (e instanceof NotFoundError) return new Response('Not found', { status: 404 });
    throw e;
  }
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="hubium-user-${id}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
