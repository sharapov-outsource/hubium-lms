'use client';

import { type RefObject, useEffect, useRef } from 'react';

/**
 * Runs `onReset` when the form around `field` is reset (form.reset(), <button type=reset>).
 * Native inputs restore their default on their own; components keeping the value in state
 * need this to follow.
 */
export function useFormReset(field: RefObject<HTMLElement | null>, onReset: () => void): void {
  const latest = useRef(onReset);
  latest.current = onReset;
  useEffect(() => {
    const form = field.current?.closest('form');
    if (!form) return;
    const handler = () => latest.current();
    form.addEventListener('reset', handler);
    return () => form.removeEventListener('reset', handler);
  }, [field]);
}
