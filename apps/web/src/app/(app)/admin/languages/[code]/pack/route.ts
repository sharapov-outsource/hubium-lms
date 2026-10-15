import { languagePackZip } from '@hubium/core';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Admin: a language pack as a zip laid out as the repository is (en is the template). */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('site:config').catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  let zip: Uint8Array;
  try {
    zip = languagePackZip(code);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  return new Response(new Uint8Array(zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="hubium-${code}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}
