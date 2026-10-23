'use server';

import { unlockByToken } from '@hubium/core';
import { redirect } from 'next/navigation';
import { getContext } from '@/server/session';

export async function unlockAccountAction(token: string): Promise<void> {
  const ok = await unlockByToken.run(await getContext(), { token });
  redirect(ok ? '/unlock-account?done=1' : '/unlock-account?invalid=1');
}
