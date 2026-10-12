import 'server-only';
import { type ActionResult, toActionError } from '@hubium/core';

export type { ActionResult };

/** Runs a server-action body and maps thrown errors to a serialisable result. */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
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
    return toActionError(e);
  }
}

export function formToObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries())
    if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v;
  return out;
}
