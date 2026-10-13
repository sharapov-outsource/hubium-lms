'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true afterwards. Use it for values only the
 * browser knows (its time zone), so server and client markup match.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
