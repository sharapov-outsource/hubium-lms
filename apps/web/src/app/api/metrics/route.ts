import { timingSafeEqual } from 'node:crypto';
import { prometheusMetrics } from '@hubium/core';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';

/** Prometheus scrape endpoint; enabled by METRICS_TOKEN (Authorization: Bearer <token>). */
export async function GET(req: Request) {
  const token = process.env.METRICS_TOKEN;
  if (!token) return new Response('Not found', { status: 404 });
  const got = Buffer.from(req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
  const want = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want))
    return new Response('Unauthorized', { status: 401 });
  return new Response(await prometheusMetrics(db), {
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
