'use server';

import { unsubscribeByToken } from '@hubium/core';
import { redirect } from 'next/navigation';
import { getContext } from '@/server/session';

export async function unsubscribeAction(token: string): Promise<void> {
  await unsubscribeByToken.run(await getContext(), { token });
  redirect(`/unsubscribe/${token}?done=1`);
}
