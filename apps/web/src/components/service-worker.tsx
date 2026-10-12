'use client';

import { useEffect } from 'react';

/** Registers the service worker (offline fallback, Web Push). */
export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator)
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, []);
  return null;
}
