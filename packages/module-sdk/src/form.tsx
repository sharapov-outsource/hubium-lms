'use client';

import { createContext, useContext, useState } from 'react';

/** Field errors of the surrounding form, keyed by input name (e.g. "settings.url"). */
export const FieldErrorsContext = createContext<Record<string, string[]> | undefined>(undefined);

export function useFieldErrors(name: string): string[] | undefined {
  return useContext(FieldErrorsContext)?.[name];
}

function toLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A datetime-local input that submits an ISO timestamp in `name`, converting from the
 * browser's time zone (datetime-local values have no zone of their own).
 */
export function DateTimeInput({
  name,
  id,
  defaultValue,
  className,
  ariaInvalid,
}: {
  name: string;
  id: string;
  defaultValue?: string | null;
  className?: string;
  ariaInvalid?: boolean;
}) {
  const [local, setLocal] = useState(() => toLocalValue(defaultValue));
  const iso = local ? new Date(local).toISOString() : '';
  return (
    <>
      <input
        id={id}
        type="datetime-local"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        aria-invalid={ariaInvalid}
        className={
          className ??
          'h-9 w-full rounded-md border border-input bg-background px-3 text-sm aria-[invalid=true]:border-destructive'
        }
      />
      <input type="hidden" name={name} value={iso} />
    </>
  );
}

export interface ModuleActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}

/**
 * Calls a module action through the host's generic endpoint. Files are sent as multipart
 * parts named `files` and arrive in the action input as `{ name, mimeType, data }`.
 */
export async function callModuleAction<T = unknown>(
  activityId: string,
  action: string,
  input: Record<string, unknown>,
  files?: { field?: string; list: File[] },
): Promise<ModuleActionResult<T>> {
  const fd = new FormData();
  fd.set('activityId', activityId);
  fd.set('action', action);
  fd.set('input', JSON.stringify(input));
  if (files) {
    fd.set('filesField', files.field ?? 'files');
    for (const f of files.list) fd.append('files', f);
  }
  try {
    const r = await fetch('/api/mod/action', { method: 'POST', body: fd });
    return (await r.json()) as ModuleActionResult<T>;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}
