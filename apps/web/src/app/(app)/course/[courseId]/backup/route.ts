import { exportCourse } from '@hubium/interchange';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('backup:create', courseId).catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  const course = await ctx.db.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { shortName: true },
  });
  const zip = await exportCourse(ctx, courseId);
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const name = `${course.shortName.replace(/[^\w.-]+/g, '_') || 'course'}-${date}.hubium`;
  return new Response(zip as Uint8Array<ArrayBuffer>, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}
