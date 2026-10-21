import { withWriteScope } from '@hubium/db';
import { log } from '@hubium/log';
import { msg, type OfflinePolicy, renderMsg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { MutationContext, RequestContext } from './context.ts';
import { AppError, type MsgOrText, ValidationError } from './errors.ts';
import { withActorScope } from './events/actor-scope.ts';
import { issueMsg } from './issue-messages.ts';

const logger = log('operations');

// One operation, three transports (server actions, REST, worker). See architecture §1.4.

export interface OperationDef<I extends z.ZodType, O> {
  name: string;
  /** What a local node does with it without a connection (OfflinePolicy). */
  offline: OfflinePolicy;
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

// Every operation by name: a local node records them by name and the cloud replays them.
const registry = new Map<string, Operation<z.ZodType, unknown>>();
/** How many times each name was defined: once, or two operations share it. */
const definitions = new Map<string, number>();

export function defineOperation<I extends z.ZodType, O>(def: OperationDef<I, O>): Operation<I, O> {
  const op: Operation<I, O> = {
    ...def,
    run(ctx, raw) {
      return withActorScope(ctx.actor, () => runOperation(def, ctx, raw));
    },
  };
  registry.set(def.name, op as Operation<z.ZodType, unknown>);
  definitions.set(def.name, (definitions.get(def.name) ?? 0) + 1);
  return op;
}

/** The operation of a name, among those of the modules loaded so far. */
export function getOperation(name: string): Operation<z.ZodType, unknown> | undefined {
  return registry.get(name);
}

export function listOperations(): Operation<z.ZodType, unknown>[] {
  return [...registry.values()];
}

/** Names defined more than once (a reload in development defines them again). */
export function duplicateOperationNames(): string[] {
  return [...definitions].filter(([, n]) => n > 1).map(([name]) => name);
}

async function runOperation<I extends z.ZodType, O>(
  def: OperationDef<I, O>,
  ctx: RequestContext,
  raw: unknown,
): Promise<O> {
  const input = parseInput(def.input, raw);
  if (def.authorize) await def.authorize(ctx, input);
  // the handler's writes and its after-commit steps belong to the operation
  return withWriteScope('operation', def.name, async () => {
    const after: (() => void | Promise<void>)[] = [];
    let result: O;
    if (def.mutation === false) {
      result = await def.handler(
        { ...ctx, tx: ctx.db, afterCommit: (fn) => after.push(fn) },
        input,
      );
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
  });
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: string;
      /** In the language of whoever asked. */
      message: string;
      /** What the message says, for code to tell: its key in the language packs. */
      reason?: string;
      fieldErrors?: Record<string, string[]>;
    };

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
      ...(e.msg ? { reason: e.msg.key } : {}),
      fieldErrors,
    };
  }
  const prisma = e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : null;
  // Unique constraint races (two requests creating the same thing) surface as a conflict.
  if (prisma === 'P2002') return { ok: false, code: 'CONFLICT', message: t(msg('errors.inUse')) };
  // a row someone else removed meanwhile, or a reference to one that is not there: the
  // request's, not the server's fault
  if (prisma === 'P2025')
    return { ok: false, code: 'NOT_FOUND', message: t(msg('errors.NOT_FOUND')) };
  if (prisma === 'P2003')
    return { ok: false, code: 'VALIDATION', message: t(msg('errors.VALIDATION')) };
  logger.error({ err: e }, 'unexpected error');
  return { ok: false, code: 'INTERNAL', message: t(msg('errors.INTERNAL')) };
}
