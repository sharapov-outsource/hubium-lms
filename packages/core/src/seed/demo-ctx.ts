import type { Db } from '@hubium/db';
import { invalidatePermissionCaches, loadUserAccess, Permissions } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';
import { isModuleEnabled } from '../settings/modules.ts';
import { getAllSettings } from '../settings/settings.ts';

/** The demo leaves out activity types turned off in Administration → Modules. */
export async function enabled(db: Db, key: string): Promise<boolean> {
  return isModuleEnabled(await getAllSettings(db), key);
}

export function systemCtx(db: Db): RequestContext {
  return {
    db,
    actor: { kind: 'system' },
    perm: new Permissions(db, { kind: 'system' }),
    now: new Date(),
    locale: 'ru',
    origin: 'CLI',
  };
}

/**
 * A demo user acting as if signed in: what learners do (answers, entries, essays) and what
 * modules keep only from a person (glossary entries, wiki pages) is done in their name.
 * Taken after the user's enrolments, which it reads once.
 */
export async function userCtx(db: Db, username: string): Promise<RequestContext> {
  const user = await db.user.findFirstOrThrow({ where: { username } });
  invalidatePermissionCaches();
  return {
    db,
    actor: { kind: 'user', userId: user.id, isSiteAdmin: user.isSiteAdmin },
    perm: new Permissions(db, await loadUserAccess(db, user)),
    now: new Date(),
    locale: 'ru',
    origin: 'CLI',
  };
}
