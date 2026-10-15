import { assertionDocument, badgeOrigin } from '@hubium/core';
import { db } from '@/server/db';
import { badgeJson } from '../../json';

export const dynamic = 'force-dynamic';

/** Open Badges 2.0 hosted verification: an award's assertion (410 once revoked). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = /^[0-9a-f-]{36}$/.test(id) ? await assertionDocument(db, badgeOrigin(), id) : null;
  return doc ? badgeJson(doc.body, doc.status) : new Response('Not found', { status: 404 });
}
