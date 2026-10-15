import { exportFrameworkCsv } from '@hubium/core';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** The framework as Moodle's competency framework CSV. */
export async function GET(_req: Request, { params }: { params: Promise<{ frameworkId: string }> }) {
  const { frameworkId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(frameworkId)) return new Response('Not found', { status: 404 });
  const ctx = await getContext();
  const csv = await exportFrameworkCsv(ctx, frameworkId).catch(() => null);
  if (csv === null) return new Response('Not found', { status: 404 });
  const f = await db.competencyFramework.findUnique({ where: { id: frameworkId } });
  const name = `${f?.idNumber ?? 'framework'}.csv`.replace(/[\\/:*?"<>|]+/g, '_');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}
