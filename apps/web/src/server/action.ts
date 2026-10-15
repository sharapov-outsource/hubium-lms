import 'server-only';
import { type ActionResult, authErrorText, toActionError, withActorScope } from '@hubium/core';
import { APIError } from 'better-auth/api';
import { getLocale } from 'next-intl/server';
import { getContext, requireNoGate } from './session';

export type { ActionResult };

/**
 * Runs a server-action body and maps thrown errors to a serialisable result. Someone with a
 * step to take first (accountGate) is refused, except by the actions of that step's page
 * (`duringGate`). `fields` names the form's field for an error the operation keys
 * otherwise (a setting's key, a nested input such as mapping.email), so it shows there; a
 * key ending in a dot renames a prefix (mapping.fields. → map_field_).
 */
export async function runAction<T>(
  fn: () => Promise<T>,
  opts: { duringGate?: boolean; fields?: Record<string, string> } = {},
): Promise<ActionResult<T>> {
  try {
    // events logged by the action record who is really behind a "log in as" session
    const { actor } = await getContext();
    if (!opts.duringGate) await requireNoGate();
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
    // what went wrong, in the language of the page
    const locale = await getLocale().catch(() => 'en');
    if (e instanceof APIError)
      return {
        ok: false,
        code: String(e.status),
        message: authErrorText(e.body, locale) ?? e.message,
      };
    const r = toActionError(e, locale);
    return opts.fields ? onFields(r, opts.fields) : r;
  }
}

/** The result's errors under the form's field names. */
function onFields<T extends { fieldErrors?: Record<string, string[]> }>(
  r: T,
  fields: Record<string, string>,
): T {
  if (!r.fieldErrors) return r;
  const out: Record<string, string[]> = {};
  const named = (k: string) => {
    if (fields[k]) return fields[k];
    const p = Object.keys(fields).find((f) => f.endsWith('.') && k.startsWith(f));
    return p ? fields[p] + k.slice(p.length) : k;
  };
  for (const [k, v] of Object.entries(r.fieldErrors)) (out[named(k)] ??= []).push(...v);
  return { ...r, fieldErrors: out };
}

export function formToObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries())
    if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v;
  return out;
}
