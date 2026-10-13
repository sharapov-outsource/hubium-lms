import { exportGradesCsv, exportGradesXlsx } from '@hubium/core';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Grades as CSV (default) or, with ?format=xlsx, as an Excel workbook. */
export async function GET(req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('grade:export', courseId).catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { shortName: true },
  });
  const xlsx = new URL(req.url).searchParams.get('format') === 'xlsx';
  const name = `grades-${course?.shortName ?? courseId}.${xlsx ? 'xlsx' : 'csv'}`;
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  if (xlsx)
    return new Response(Buffer.from(await exportGradesXlsx(ctx, courseId)), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': disposition,
      },
    });
  return new Response(await exportGradesCsv(ctx, courseId), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': disposition },
  });
}
