import { withWriteScope } from '@hubium/db';
import { ModuleError, msg } from '@hubium/module-sdk';
import type { RequestContext } from '../context.ts';
import { getActivityAccess } from '../courses/activities.ts';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
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

/**
 * Input of an action sent as multipart form data: the JSON input in `input` and uploaded
 * files as `files` parts, handed to the action under `filesField` (default `files`).
 */
export async function actionInputFromForm(form: {
  input?: unknown;
  filesField?: unknown;
  files?: unknown;
}): Promise<Record<string, unknown>> {
  let input: unknown;
  try {
    input = JSON.parse(typeof form.input === 'string' && form.input ? form.input : '{}');
  } catch {
    throw new ValidationError({ input: [msg('errors.modules.invalidJson')] });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ValidationError({ input: [msg('errors.modules.jsonObject')] });
  const parts = Array.isArray(form.files) ? form.files : form.files ? [form.files] : [];
  const files = await Promise.all(
    parts
      .filter((f): f is File => f instanceof File && f.size > 0)
      .map(async (f) => ({
        name: f.name,
        mimeType: f.type || 'application/octet-stream',
        data: Buffer.from(await f.arrayBuffer()),
      })),
  );
  const field = typeof form.filesField === 'string' && form.filesField ? form.filesField : 'files';
  if (files.length) (input as Record<string, unknown>)[field] = files;
  return input as Record<string, unknown>;
}

/**
 * Module handlers throw plain Errors with messages for the user (a bad request, not a crash)
 * or a ModuleError that names its status.
 */
function userError(e: unknown): unknown {
  if (e instanceof ModuleError) return new AppError(e.status, e.msg ?? e.message, { cause: e });
  return e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && !('code' in e)
    ? new AppError('BAD_REQUEST', e.message, { cause: e })
    : e;
}

/** The activity and its module, when the caller may open it (actions and queries alike). */
async function openModuleActivity(ctx: RequestContext, activityId: string) {
  const { activity, canOpen, moduleDisabled } = await getActivityAccess(ctx, activityId);
  if (moduleDisabled) throw new ForbiddenError(msg('errors.common.moduleDisabled'));
  if (!canOpen || activity.deletedAt) throw new ForbiddenError(msg('errors.modules.notAvailable'));
  return { activity, module: requireModule(activity.moduleKey) };
}

/** Runs `ActivityModule.queries[name]`: a read, with the same access checks as actions. */
export function runModuleQuery(
  ctx: RequestContext,
  activityId: string,
  name: string,
  raw: unknown,
): Promise<unknown> {
  return withActorScope(ctx.actor, async () => {
    const { activity, module: m } = await openModuleActivity(ctx, activityId);
    const query = m.queries?.[name];
    if (!query) throw new NotFoundError(`Query ${name}`);
    if (query.capability) await ctx.perm.require(query.capability as never, activityId);
    const input = parseInput(query.input, raw);
    return query.handler(buildModuleCtx(ctx), toActivityRef(activity), input);
  }).catch((e) => {
    throw userError(e);
  });
}

async function runAction(
  ctx: RequestContext,
  activityId: string,
  name: string,
  raw: unknown,
): Promise<unknown> {
  const { activity, module: m } = await openModuleActivity(ctx, activityId);
  const action = m.actions?.[name];
  if (!action) throw new NotFoundError(`Action ${name}`);
  if (action.capability) await ctx.perm.require(action.capability as never, activityId);
  const input = parseInput(action.input, raw);
  const ref = toActivityRef(activity);
  return withWriteScope('operation', `${m.key}.${name}`, () =>
    action.mutation === false
      ? action.handler(buildModuleCtx(ctx), ref, input)
      : ctx.db.$transaction((tx) => action.handler(buildModuleCtx(ctx, tx), ref, input), {
          timeout: 60_000,
        }),
  );
}
