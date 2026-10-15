import { badgeOrigin, bakedBadgeImage } from '@hubium/core';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';

/** The badge image baked with the award's assertion, to keep or share. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const img = /^[0-9a-f-]{36}$/.test(id) ? await bakedBadgeImage(db, badgeOrigin(), id) : null;
  if (!img) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(img.data), {
    headers: {
      'Content-Type': img.mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(img.name)}`,
      'X-Content-Type-Options': 'nosniff',
      // an SVG opened by itself must not run anything
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': 'private, max-age=300',
    },
  });
}
