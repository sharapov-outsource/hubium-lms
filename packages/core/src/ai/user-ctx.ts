import type { Db } from '@hubium/db';
import { loadUserAccess, Permissions } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';

/** Request context for background work done on behalf of a user. */
export async function userContext(db: Db, userId: string): Promise<RequestContext> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return {
    db,
    actor: { kind: 'user', userId, isSiteAdmin: user.isSiteAdmin },
    perm: new Permissions(db, await loadUserAccess(db, user)),
    now: new Date(),
    locale: user.locale === 'en' ? 'en' : 'ru',
    origin: 'WORKER',
  };
}
