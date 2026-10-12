import { exportGradesCsv } from '@hubium/core';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('grade:export', courseId).catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { shortName: true },
  });
  const csv = await exportGradesCsv(ctx, courseId);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`grades-${course?.shortName ?? courseId}.csv`)}`,
    },
  });
}
