import { exportReport } from '@hubium/core';
import { readFilters } from '@/server/report-filters';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** The report with the viewer's filters, as CSV or XLSX. */
export async function GET(req: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(reportId)) return new Response('Not found', { status: 404 });
  const url = new URL(req.url);
  const sp: Record<string, string | string[]> = {};
  for (const k of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(k);
    sp[k] = all.length > 1 ? all : all[0]!;
  }
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
  const file = await exportReport(
    await getContext(),
    reportId,
    format,
    readFilters(sp).filters,
  ).catch(() => null);
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'private, no-store',
    },
  });
}
