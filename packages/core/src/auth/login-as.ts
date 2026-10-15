import { type Db, SYSTEM_CONTEXT_ID } from '@hubium/db';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { loadUserAccess, Permissions } from '../access/permissions.ts';
import { logEvent } from '../events/log.ts';

// "Log in as": Better Auth's impersonation session, behind Hubium's own permission check
// (its admin plugin only knows User.role, which Hubium does not use). The cookies match
// the admin plugin's, so its /admin/stop-impersonating brings the person back.

/** A "log in as" session ends after an hour. */
export const LOGIN_AS_SECONDS = 3600;

/** Why `actorId` may not log in as `targetId`, or null when it is allowed. */
export async function loginAsDenial(
  db: Db,
  actorId: string,
  targetId: string,
): Promise<{ code: string; message: string } | null> {
  const no = (code: string, message: string) => ({ code, message });
  if (actorId === targetId) return no('LOGIN_AS_SELF', 'You are already signed in as this user');
  const select = { id: true, isSiteAdmin: true, status: true } as const;
  const [actor, target] = await Promise.all([
    db.user.findUnique({ where: { id: actorId }, select }),
    db.user.findUnique({ where: { id: targetId }, select }),
  ]);
  if (actor?.status !== 'ACTIVE') return no('SIGN_IN_REQUIRED', 'Sign in required');
  if (!target || target.status === 'DELETED') return no('USER_NOT_FOUND', 'User not found');
  if (target.status !== 'ACTIVE') return no('ACCOUNT_SUSPENDED', 'This account is suspended');
  // As in Moodle, only a site administrator may become another administrator.
  if (target.isSiteAdmin && !actor.isSiteAdmin)
    return no('LOGIN_AS_ADMIN', 'Only site administrators can log in as an administrator');
  const perm = new Permissions(db, await loadUserAccess(db, actor));
  if (!(await perm.can('user:loginas', SYSTEM_CONTEXT_ID)))
    return no('LOGIN_AS_NOT_ALLOWED', 'You are not allowed to log in as other users');
  return null;
}

export function impersonatedBy(session: object | null | undefined): string | null {
  return (session as { impersonatedBy?: string | null } | null)?.impersonatedBy ?? null;
}

export function loginAs(db: Db) {
  return {
    id: 'hubium-login-as',
    endpoints: {
      loginAs: createAuthEndpoint(
        '/hubium/login-as',
        {
          method: 'POST',
          body: z.object({ userId: z.string().uuid() }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const current = ctx.context.session;
          if (impersonatedBy(current.session))
            throw new APIError('BAD_REQUEST', {
              code: 'LOGIN_AS_NESTED',
              message: 'Return to your own account first',
            });
          const denial = await loginAsDenial(db, current.user.id, ctx.body.userId);
          if (denial) throw new APIError('FORBIDDEN', denial);
          const target = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!target)
            throw new APIError('NOT_FOUND', { code: 'USER_NOT_FOUND', message: 'User not found' });
          const session = await ctx.context.internalAdapter.createSession(
            target.id,
            true,
            {
              impersonatedBy: current.user.id,
              expiresAt: new Date(Date.now() + LOGIN_AS_SECONDS * 1000),
            },
            true,
          );
          if (!session)
            throw new APIError('INTERNAL_SERVER_ERROR', {
              code: 'FAILED_TO_CREATE_SESSION',
              message: 'Could not start the session',
            });
          const cookies = ctx.context.authCookies;
          deleteSessionCookie(ctx);
          const dontRemember = await ctx.getSignedCookie(
            cookies.dontRememberToken.name,
            ctx.context.secret,
          );
          await ctx.setSignedCookie(
            ctx.context.createAuthCookie('admin_session').name,
            `${current.session.token}:${dontRemember || ''}`,
            ctx.context.secret,
            cookies.sessionToken.attributes,
          );
          await setSessionCookie(ctx, { session, user: target }, true);
          await logEvent(db, {
            name: 'user.loggedinas',
            actorId: current.user.id,
            realActorId: null,
            contextId: SYSTEM_CONTEXT_ID,
            objectType: 'user',
            objectId: target.id,
            relatedUserId: target.id,
          });
          return ctx.json({ userId: target.id });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
