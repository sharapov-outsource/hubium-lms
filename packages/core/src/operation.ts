import { log } from '@hubium/log';
import { msg, renderMsg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { MutationContext, RequestContext } from './context.ts';
import { AppError, type MsgOrText, ValidationError } from './errors.ts';
import { withActorScope } from './events/actor-scope.ts';
import { issueMsg } from './issue-messages.ts';

const logger = log('operations');

// One operation, three transports (server actions, REST, worker). See architecture §1.4.

export interface OperationDef<I extends z.ZodType, O> {
  name: string;
  input: I;
  authorize?: (ctx: RequestContext, input: z.output<I>) => Promise<void> | void;
  handler: (ctx: MutationContext, input: z.output<I>) => Promise<O>;
  /** Mutations run inside a transaction; queries do not. */
  mutation?: boolean;
}

export interface Operation<I extends z.ZodType, O> extends OperationDef<I, O> {
  run(ctx: RequestContext, raw: unknown): Promise<O>;
}

/** A schema's issues by field, as messages for people. */
export function zodFieldErrors(error: z.ZodError): Record<string, MsgOrText[]> {
  const out: Record<string, MsgOrText[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issueMsg(issue));
  }
  return out;
}

export function parseInput<I extends z.ZodType>(schema: I, raw: unknown): z.output<I> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError(zodFieldErrors(r.error));
  return r.data;
}

export function defineOperation<I extends z.ZodType, O>(def: OperationDef<I, O>): Operation<I, O> {
  return {
    ...def,
    run(ctx, raw) {
      return withActorScope(ctx.actor, () => runOperation(def, ctx, raw));
    },
  };
}

async function runOperation<I extends z.ZodType, O>(
  def: OperationDef<I, O>,
  ctx: RequestContext,
  raw: unknown,
): Promise<O> {
  const input = parseInput(def.input, raw);
  if (def.authorize) await def.authorize(ctx, input);
  const after: (() => void | Promise<void>)[] = [];
  let result: O;
  if (def.mutation === false) {
    result = await def.handler({ ...ctx, tx: ctx.db, afterCommit: (fn) => after.push(fn) }, input);
  } else {
    result = await ctx.db.$transaction(
      (tx) => def.handler({ ...ctx, tx, afterCommit: (fn) => after.push(fn) }, input),
      { timeout: 30_000 },
    );
  }
  for (const fn of after) {
    try {
      await fn();
    } catch (e) {
      logger.error({ err: e, operation: def.name }, 'after-commit step failed');
    }
  }
  return result;
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; fieldErrors?: Record<string, string[]> };

/**
 * Maps thrown errors to a serialisable result for server actions, in the language of the
 * person who asked (English by default: API clients).
 */
export function toActionError(
  e: unknown,
  locale = 'en',
): Extract<ActionResult<never>, { ok: false }> {
  const t = (m: MsgOrText) => renderMsg(m, locale);
  if (e instanceof z.ZodError) e = new ValidationError(zodFieldErrors(e));
  if (e instanceof AppError) {
    const { message, fieldErrors } = e.in(locale);
    // a refusal says why: the first field error rather than "Validation failed" (forms
    // show every field's error by the field; toasts show the message)
    const first = fieldErrors ? Object.values(fieldErrors).flat()[0] : undefined;
    return {
      ok: false,
      code: e.code,
      message:
        e instanceof ValidationError && e.message === 'Validation failed'
          ? (first ?? t(msg('errors.VALIDATION')))
          : message,
      fieldErrors,
    };
  }
  // Unique constraint races (two requests creating the same thing) surface as a conflict.
  if (e && typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === 'P2002') {
    return { ok: false, code: 'CONFLICT', message: t(msg('errors.inUse')) };
  }
  logger.error({ err: e }, 'unexpected error');
  return { ok: false, code: 'INTERNAL', message: t(msg('errors.INTERNAL')) };
}
