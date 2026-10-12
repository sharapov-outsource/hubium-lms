import { z } from 'zod';
import type { MutationContext, RequestContext } from './context.ts';
import { AppError, ValidationError } from './errors.ts';

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

export function zodFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
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
    async run(ctx, raw) {
      const input = parseInput(def.input, raw);
      if (def.authorize) await def.authorize(ctx, input);
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
          console.error(`[${def.name}] afterCommit failed`, e);
        }
      }
      return result;
    },
  };
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; fieldErrors?: Record<string, string[]> };

/** Maps thrown errors to a serialisable result for server actions. */
export function toActionError(e: unknown): Extract<ActionResult<never>, { ok: false }> {
  if (e instanceof AppError) {
    return { ok: false, code: e.code, message: e.message, fieldErrors: e.fieldErrors };
  }
  // Unique constraint races (two requests creating the same thing) surface as a conflict.
  if (e && typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === 'P2002') {
    return { ok: false, code: 'CONFLICT', message: 'This value is already in use' };
  }
  if (e instanceof z.ZodError) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Validation failed',
      fieldErrors: zodFieldErrors(e),
    };
  }
  console.error(e);
  return { ok: false, code: 'INTERNAL', message: 'Internal error' };
}
