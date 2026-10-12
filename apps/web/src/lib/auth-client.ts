'use client';

import { adminClient, twoFactorClient, usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  plugins: [
    usernameClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        const next = new URLSearchParams(window.location.search).get('next');
        window.location.href = `/two-factor${next ? `?next=${encodeURIComponent(next)}` : ''}`;
      },
    }),
    adminClient(),
  ],
});

/** Only allow same-site relative redirects. */
export function safeNext(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next?.startsWith('/') || next.startsWith('//')) return fallback;
  return next;
}
