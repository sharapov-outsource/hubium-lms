import type { RequestContext } from '../context.ts';
import { getActivityAccess } from '../courses/activities.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { withActorScope } from '../events/actor-scope.ts';
import { parseInput } from '../operation.ts';
import { buildModuleCtx, toActivityRef } from './module-ctx.ts';
import { requireModule } from './registry.ts';

/** Runs `ActivityModule.actions[name]` with access, capability and input checks. */
export function runModuleAction(
  ctx: RequestContext,
  activityId: string,
  name: string,
  raw: unknown,
): Promise<unknown> {
  return withActorScope(ctx.actor, () => runAction(ctx, activityId, name, raw)).catch((e) => {
    throw userError(e);
  });
}

/** Module handlers throw plain Errors with messages for the user: a bad request, not a crash. */
function userError(e: unknown): unknown {
  return e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && !('code' in e)
    ? new AppError('BAD_REQUEST', e.message, { cause: e })
    : e;
}

async function runAction(
  ctx: RequestContext,
  activityId: string,
  name: string,
  raw: unknown,
): Promise<unknown> {
  const { activity, canOpen } = await getActivityAccess(ctx, activityId);
  if (!canOpen || activity.deletedAt) throw new ForbiddenError('Activity is not available');
  const m = requireModule(activity.moduleKey);
  const action = m.actions?.[name];
  if (!action) throw new NotFoundError(`Action ${name}`);
  if (action.capability) await ctx.perm.require(action.capability as never, activityId);
  const input = parseInput(action.input, raw);
  const ref = toActivityRef(activity);
  if (action.mutation === false) return action.handler(buildModuleCtx(ctx), ref, input);
  return ctx.db.$transaction((tx) => action.handler(buildModuleCtx(ctx, tx), ref, input), {
    timeout: 60_000,
  });
}
