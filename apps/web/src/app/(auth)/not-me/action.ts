'use server';

import { reportNotMeByToken } from '@hubium/core';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { getContext } from '@/server/session';

/** Ends every session and, when the account has an email, sends a password reset link. */
export async function reportNotMeAction(token: string): Promise<void> {
  const r = await reportNotMeByToken.run(await getContext(), { token });
  if (!r) redirect('/not-me?invalid=1');
  if (r.email)
    await auth.api.requestPasswordReset({
      body: { email: r.email, redirectTo: '/reset-password' },
    });
  redirect(`/not-me?done=${r.email ? 'reset' : 'sessions'}`);
}
