import { getAllSettings, listUserEvents, toICal, userForFeedToken } from '@hubium/core';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const userId = await userForFeedToken(db, token.replace(/\.ics$/, ''));
  if (!userId) return new Response('Not found', { status: 404 });
  const now = Date.now();
  const events = await listUserEvents(db, userId, {
    from: new Date(now - 30 * 86_400_000),
    to: new Date(now + 365 * 86_400_000),
  });
  const settings = await getAllSettings(db);
  const base = process.env.APP_URL ?? 'http://localhost:3000';
  const body = toICal(events, {
    name: settings['site.name'],
    host: new URL(base).host,
    baseUrl: base,
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
