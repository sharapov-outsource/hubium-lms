'use server';

import { retryTaskRun, runTaskNow } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { runAction } from '../action';
import { getContext } from '../session';

export async function runTaskNowAction(name: string) {
  return runAction(async () => {
    const r = await runTaskNow(await getContext(), name);
    revalidatePath('/admin/tasks');
    return r;
  });
}

export async function retryTaskRunAction(name: string, id: string) {
  return runAction(async () => {
    const r = await retryTaskRun(await getContext(), { name, id });
    revalidatePath('/admin/tasks');
    return r;
  });
}
