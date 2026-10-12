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

/**
 * Uploads a large file in chunks to /api/uploads and resumes after network errors or a
 * page reload (the session id is remembered per file). Resolves with the upload id to
 * pass to a module action.
 */
export async function uploadResumable(
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const memo = `hubium-upload:${file.name}:${file.size}:${file.lastModified}`;
  const remember = (id: string | null) => {
    try {
      if (id) localStorage.setItem(memo, id);
      else localStorage.removeItem(memo);
    } catch {}
  };
  let id: string | null = null;
  let chunkSize = 5 * 1024 * 1024;
  let offset = 0;
  try {
    id = localStorage.getItem(memo);
  } catch {}
  if (id) {
    const r = await fetch(`/api/uploads/${id}`, { signal: opts.signal });
    if (r.ok) {
      const s = (await r.json()) as { received: number; done: boolean };
      if (s.done) id = null;
      else offset = s.received;
    } else id = null;
  }
  if (!id) {
    const r = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type }),
      signal: opts.signal,
    });
    const s = (await r.json()) as { id?: string; chunkSize?: number; message?: string };
    if (!r.ok || !s.id) throw new Error(s.message ?? 'Upload failed');
    id = s.id;
    chunkSize = s.chunkSize ?? chunkSize;
    remember(id);
  }
  let failures = 0;
  while (offset < file.size) {
    opts.onProgress?.(offset / file.size);
    try {
      const r = await fetch(`/api/uploads/${id}`, {
        method: 'PATCH',
        headers: {
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: file.slice(offset, offset + chunkSize),
        signal: opts.signal,
      });
      const s = (await r.json()) as { received?: number; message?: string };
      if (r.status === 409 || r.ok) {
        offset = s.received ?? offset;
        failures = 0;
        continue;
      }
      throw new Error(s.message ?? `HTTP ${r.status}`);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (++failures > 6) throw e;
      // exponential backoff, then ask the server where to continue
      await new Promise((res) => setTimeout(res, 500 * 2 ** failures));
      const s: { received?: number } = await fetch(`/api/uploads/${id}`).then(
        (r) => r.json() as Promise<{ received?: number }>,
        () => ({}),
      );
      if (typeof s.received === 'number') offset = s.received;
    }
  }
  opts.onProgress?.(1);
  remember(null);
  return id;
}
