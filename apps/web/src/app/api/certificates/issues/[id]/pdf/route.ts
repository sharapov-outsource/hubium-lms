import { certificatePdf } from '@hubium/core';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** An issued certificate as a PDF, for its owner and those who see the course's issues. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pdf = /^[0-9a-f-]{36}$/.test(id) ? await certificatePdf(await getContext(), id) : null;
  if (!pdf) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(pdf.data), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(pdf.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
