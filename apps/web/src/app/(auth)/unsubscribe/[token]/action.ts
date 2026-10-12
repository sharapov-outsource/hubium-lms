'use server';

import { applyUnsubscribe } from '@hubium/core';
import { redirect } from 'next/navigation';
import { serverModules } from '@/modules/server';
import { db } from '@/server/db';

export async function unsubscribeAction(token: string): Promise<void> {
  await applyUnsubscribe(
    db,
    token,
    serverModules.map((m) => m.key),
  );
  redirect(`/unsubscribe/${token}?done=1`);
}
