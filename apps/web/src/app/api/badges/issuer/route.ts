import { badgeOrigin, issuerDocument } from '@hubium/core';
import { db } from '@/server/db';
import { badgeJson } from '../json';

export const dynamic = 'force-dynamic';

/** Open Badges 2.0: the site as the issuer of its badges. */
export async function GET() {
  return badgeJson(await issuerDocument(db, badgeOrigin()));
}
