import { badgeClassDocument, badgeOrigin } from '@hubium/core';
import { db } from '@/server/db';
import { badgeJson } from '../../json';

export const dynamic = 'force-dynamic';

/** Open Badges 2.0: a badge class (not drafts). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = /^[0-9a-f-]{36}$/.test(id) ? await badgeClassDocument(db, badgeOrigin(), id) : null;
  return doc ? badgeJson(doc) : new Response('Not found', { status: 404 });
}
