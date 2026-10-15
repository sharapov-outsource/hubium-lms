'use client';

import { Button, DatePicker, DateTimePicker } from '@hubium/ui';
import { Dialog, DialogContent, DialogFooter } from '@hubium/ui/dialog';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { fromZonedValue, toZonedValue } from './zoned.ts';

export { fromZonedValue, toZonedValue } from './zoned.ts';

/** Field errors of the surrounding form, keyed by input name (e.g. "settings.url"). */
export const FieldErrorsContext = createContext<Record<string, string[]> | undefined>(undefined);

export function useFieldErrors(name: string): string[] | undefined {
  return useContext(FieldErrorsContext)?.[name];
}

/**
 * Pickers work in the user's profile time zone, the one dates are shown in everywhere
 * else, whatever zone the browser is in: an instant to the picker's value and back.
 */
export function useZonedValue() {
  const timeZone = useTimeZone() ?? 'UTC';
  return {
    timeZone,
    toLocal: (iso: string | null | undefined) => toZonedValue(iso, timeZone),
    toIso: (local: string | null | undefined) => fromZonedValue(local, timeZone),
  };
}

/** Locale and texts of the date pickers, from the app's messages. */
function usePickerText() {
  const t = useTranslations('common.datePicker');
  const locale = useLocale();
  return {
    locale,
    labels: {
      placeholder: t('placeholder'),
      clear: t('clear'),
      today: t('today'),
      time: t('time'),
      timePlaceholder: t('timePlaceholder'),
      calendar: {
        previousMonth: t('previousMonth'),
        nextMonth: t('nextMonth'),
        month: t('month'),
        year: t('year'),
      },
    },
  };
}

interface PickerFieldProps {
  name?: string;
  id?: string;
  required?: boolean;
  ariaInvalid?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/** Calendar date field; submits "YYYY-MM-DD" in `name`, like a native date input. */
export function DateInput({
  name,
  id,
  value,
  defaultValue,
  onChange,
  min,
  max,
  ariaInvalid,
  ...rest
}: PickerFieldProps & {
  value?: string;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  min?: string;
  max?: string;
}) {
  const { locale, labels } = usePickerText();
  const errors = useFieldErrors(name ?? '');
  return (
    <DatePicker
      id={id}
      name={name}
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      min={min}
      max={max}
      locale={locale}
      labels={labels}
      invalid={ariaInvalid ?? !!errors?.length}
      {...rest}
    />
  );
}

/**
 * Date and time as a wall-clock value; submits "YYYY-MM-DDTHH:mm" like datetime-local.
 * Convert with `useZonedValue`, so the value means the user's zone.
 */
export function LocalDateTimeInput({
  name,
  id,
  value,
  defaultValue,
  onChange,
  defaultTime,
  ariaInvalid,
  ...rest
}: PickerFieldProps & {
  value?: string;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  defaultTime?: string;
}) {
  const { locale, labels } = usePickerText();
  const errors = useFieldErrors(name ?? '');
  return (
    <DateTimePicker
      id={id}
      name={name}
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      defaultTime={defaultTime}
      locale={locale}
      labels={labels}
      invalid={ariaInvalid ?? !!errors?.length}
      {...rest}
    />
  );
}

/**
 * Date and time picker that submits an ISO timestamp in `name`. The value is shown in the
 * user's profile time zone; an untouched value is submitted exactly as it came.
 */
export function DateTimeInput({
  name,
  id,
  defaultValue,
  defaultTime,
  ariaInvalid,
  ...rest
}: PickerFieldProps & { name: string; defaultValue?: string | null; defaultTime?: string }) {
  const zoned = useZonedValue();
  const errors = useFieldErrors(name);
  const [edited, setEdited] = useState<string | null>(null);
  const local = edited ?? zoned.toLocal(defaultValue);
  const iso = edited === null ? (defaultValue ?? '') : zoned.toIso(edited);
  return (
    <>
      <LocalDateTimeInput
        id={id}
        value={local}
        onChange={setEdited}
        defaultTime={defaultTime}
        ariaInvalid={ariaInvalid ?? !!errors?.length}
        {...rest}
      />
      <input type="hidden" name={name} value={iso} />
    </>
  );
}

export interface ModuleActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  /** On failure: VALIDATION, FORBIDDEN, NOT_FOUND, CONFLICT, … */
  code?: string;
  /** On failure, in the language of the page. */
  message?: string;
  /** On failure, what the message says for code to tell: its key in the language packs. */
  reason?: string;
  fieldErrors?: Record<string, string[]>;
}

/** A failure the server explained, thrown on with its message in the person's language. */
export class ActionFailure extends Error {
  override name = 'ActionFailure';
}

/**
 * What a failure says to people: an action's result or an ActionFailure carries the server's
 * message, in their language; anything else thrown (a lost connection) and a result without
 * a message read "Something went wrong" in it.
 */
export function useFailureText() {
  const t = useTranslations('common');
  return useCallback(
    (failure: unknown) => {
      const said =
        failure instanceof ActionFailure || !(failure instanceof Error)
          ? (failure as { message?: unknown } | null | undefined)?.message
          : undefined;
      return typeof said === 'string' && said ? said : t('error');
    },
    [t],
  );
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
  } catch {
    // no answer, or not one of ours: useFailureText says something went wrong
    return { ok: false, code: 'NETWORK' };
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
    if (!r.ok || !s.id) throw new ActionFailure(s.message ?? '');
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
      throw new ActionFailure(s.message ?? '');
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

/**
 * Asking before an action, in the site's dialog rather than the browser's: `confirm(text)`
 * resolves to whether the person confirmed. The component renders `dialog` once.
 */
export function useConfirm(): [(text: ReactNode) => Promise<boolean>, ReactNode] {
  const tc = useTranslations('common');
  const [text, setText] = useState<ReactNode>(null);
  const answer = useRef<((ok: boolean) => void) | null>(null);
  const confirm = useCallback(
    (question: ReactNode) =>
      new Promise<boolean>((resolve) => {
        answer.current?.(false);
        answer.current = resolve;
        setText(question);
      }),
    [],
  );
  const close = (ok: boolean) => {
    answer.current?.(ok);
    answer.current = null;
    setText(null);
  };
  const dialog = (
    <Dialog open={text !== null} onOpenChange={(open) => !open && close(false)}>
      <DialogContent title={tc('confirm')} description={text}>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {tc('cancel')}
          </Button>
          <Button onClick={() => close(true)}>{tc('confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return [confirm, dialog];
}
