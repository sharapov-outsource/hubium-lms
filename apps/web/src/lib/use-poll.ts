'use client';

import type { ActionResult } from '@hubium/core/operation';
import { useFailureText } from '@hubium/module-sdk/form';
import { toast } from '@hubium/ui/theme';
import { useEffect, useRef } from 'react';

/** Failed asks in a row (a lost connection) after which polling gives up. */
const TRIES = 5;

/**
 * Asks `ask(key)` every `ms` until `done` says the answer is final, handing each answer to
 * `onData`. A refusal stops it and is shown, and so are failed asks once there are several
 * in a row; the timer goes when the component does or the key changes.
 */
export function usePoll<T>(
  key: string | null,
  ask: (key: string) => Promise<ActionResult<T>>,
  opts: { done: (data: T) => boolean; onData: (data: T) => void; ms?: number },
) {
  const failed = useFailureText();
  // the latest callbacks, without starting over on every render
  const latest = useRef({ ask, ...opts, failed });
  latest.current = { ask, ...opts, failed };
  useEffect(() => {
    if (!key) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const tick = async () => {
      const { ask, done, onData, ms = 1500, failed } = latest.current;
      try {
        const r = await ask(key);
        if (stop) return;
        misses = 0;
        if (!r.ok) return void toast.error(failed(r));
        onData(r.data);
        if (done(r.data)) return;
      } catch (e) {
        if (stop) return;
        if (++misses >= TRIES) return void toast.error(failed(e));
      }
      timer = setTimeout(tick, misses ? ms * 2 ** misses : ms);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [key]);
}
