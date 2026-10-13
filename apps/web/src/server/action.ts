import 'server-only';
import { type ActionResult, toActionError, withActorScope } from '@hubium/core';
import { APIError } from 'better-auth/api';
import { getContext } from './session';

export type { ActionResult };

/** Runs a server-action body and maps thrown errors to a serialisable result. */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    // events logged by the action record who is really behind a "log in as" session
    const { actor } = await getContext();
    return { ok: true, data: await withActorScope(actor, fn) };
  } catch (e) {
    // Next.js uses thrown errors for redirect()/notFound(); let them through.
    if (
      e &&
      typeof e === 'object' &&
      'digest' in e &&
      typeof (e as { digest: unknown }).digest === 'string'
    ) {
      const digest = (e as { digest: string }).digest;
      if (digest.startsWith('NEXT_') || digest.startsWith('NEXT_HTTP_ERROR')) throw e;
    }
    // Better Auth refusals carry a message meant for the person
    if (e instanceof APIError)
      return { ok: false, code: String(e.status), message: e.body?.message ?? e.message };
    return toActionError(e);
  }
}

export function formToObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries())
    if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v;
  return out;
}
