import type { Db, Prisma } from '@hubium/db';
import type { Locale } from '@hubium/i18n';
import type { Permissions } from './access/permissions.ts';

export type { Locale };

export type Actor =
  | { kind: 'system' }
  | { kind: 'anonymous' }
  | {
      kind: 'user';
      userId: string;
      isSiteAdmin: boolean;
      /** Set while impersonating ("log in as"). */
      realUserId?: string;
    };

export interface RequestContext {
  db: Db;
  actor: Actor;
  perm: Permissions;
  now: Date;
  locale: Locale;
  ip?: string | null;
  origin: 'WEB' | 'API' | 'WORKER' | 'CLI';
}

/** Context passed to mutation handlers: `tx` is the open transaction. */
export interface MutationContext extends RequestContext {
  tx: Prisma.TransactionClient;
  afterCommit(fn: () => void | Promise<void>): void;
}

export function actorUserId(actor: Actor): string | null {
  return actor.kind === 'user' ? actor.userId : null;
}

export function requireUserId(actor: Actor): string {
  if (actor.kind !== 'user') {
    throw new Error('This operation requires a signed-in user');
  }
  return actor.userId;
}
