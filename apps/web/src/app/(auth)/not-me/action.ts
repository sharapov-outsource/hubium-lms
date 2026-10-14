'use server';

import { reportNotMe } from '@hubium/core';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { db } from '@/server/db';

/** Ends every session and, when the account has an email, sends a password reset link. */
export async function reportNotMeAction(token: string): Promise<void> {
  const r = await reportNotMe(db, token);
  if (!r) redirect('/not-me?invalid=1');
  if (r.email)
    await auth.api.requestPasswordReset({
      body: { email: r.email, redirectTo: '/reset-password' },
    });
  redirect(`/not-me?done=${r.email ? 'reset' : 'sessions'}`);
}
