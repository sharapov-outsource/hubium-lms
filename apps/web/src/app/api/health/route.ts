import { db } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: 'ok', time: new Date().toISOString() });
  } catch {
    return Response.json({ status: 'error', db: 'unreachable' }, { status: 503 });
  }
}
