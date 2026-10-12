import { sendTyping } from '@hubium/core';
import { db } from '@/server/db';
import { getSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** "Typing…" pings: realtime only, so a plain route keeps server actions unblocked. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { conversationId?: unknown };
  if (typeof body.conversationId !== 'string') return new Response(null, { status: 400 });
  try {
    await sendTyping(db, session.user.id, body.conversationId);
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 404 });
  }
}
