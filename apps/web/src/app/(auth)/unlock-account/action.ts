'use server';

import { unlockWithToken } from '@hubium/core';
import { redirect } from 'next/navigation';
import { db } from '@/server/db';

export async function unlockAccountAction(token: string): Promise<void> {
  const ok = await unlockWithToken(db, token);
  redirect(ok ? '/unlock-account?done=1' : '/unlock-account?invalid=1');
}
