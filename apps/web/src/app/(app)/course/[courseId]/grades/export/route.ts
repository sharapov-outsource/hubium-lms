import { exportGradesCsv, exportGradesOds, exportGradesXlsx } from '@hubium/core';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Grades as CSV (default), or with ?format=xlsx or ?format=ods as a spreadsheet. */
export async function GET(req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('grade:export', courseId).catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { shortName: true },
  });
  const asked = new URL(req.url).searchParams.get('format');
  const format = asked === 'xlsx' || asked === 'ods' ? asked : 'csv';
  const name = `grades-${course?.shortName ?? courseId}.${format}`;
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  if (format === 'xlsx')
    return new Response(Buffer.from(await exportGradesXlsx(ctx, courseId)), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': disposition,
      },
    });
  if (format === 'ods')
    return new Response(Buffer.from(await exportGradesOds(ctx, courseId)), {
      headers: {
        'Content-Type': 'application/vnd.oasis.opendocument.spreadsheet',
        'Content-Disposition': disposition,
      },
    });
  return new Response(await exportGradesCsv(ctx, courseId), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': disposition },
  });
}
