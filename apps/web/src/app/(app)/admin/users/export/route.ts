import { exportUsers } from '@hubium/core';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

const TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
} as const;

/** Selected users (?ids=a,b) or everyone a filter finds (?all=1&q=&status=), as a sheet. */
export async function GET(req: Request) {
  const ctx = await getContext();
  if (!(await ctx.perm.can('user:update').catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  const sp = new URL(req.url).searchParams;
  const asked = sp.get('format');
  const format = asked === 'xlsx' || asked === 'ods' ? asked : 'csv';
  const s = sp.get('status');
  const status: 'ACTIVE' | 'SUSPENDED' | undefined =
    s === 'ACTIVE' || s === 'SUSPENDED' ? s : undefined;
  const selection: Parameters<typeof exportUsers>[1] =
    sp.get('all') === '1'
      ? {
          filter: {
            q: sp.get('q') ?? undefined,
            status,
          },
        }
      : { ids: (sp.get('ids') ?? '').split(',').filter(Boolean) };
  const body = await exportUsers(ctx, selection, format);
  return new Response(typeof body === 'string' ? body : Buffer.from(body), {
    headers: {
      'Content-Type': TYPES[format],
      'Content-Disposition': `attachment; filename="users.${format}"`,
    },
  });
}
