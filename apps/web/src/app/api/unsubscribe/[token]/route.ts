import { applyUnsubscribe } from '@hubium/core';
import { serverModules } from '@/modules/server';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';

/** RFC 8058 one-click unsubscribe (List-Unsubscribe-Post), no sign-in needed. */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await applyUnsubscribe(
    db,
    token,
    serverModules.map((m) => m.key),
  );
  return new Response(null, { status: r ? 200 : 400 });
}

/** Mail clients that open the header link get the confirmation page. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return Response.redirect(new URL(`/unsubscribe/${token}`, req.url), 303);
}
