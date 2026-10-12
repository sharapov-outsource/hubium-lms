'use server';

import { createApiToken, revokeApiToken } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

export async function createApiTokenAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await createApiToken(await getContext(), {
      name: v.name,
      scopes: fd.getAll('scopes').map(String),
      expiresInDays: v.expiresInDays === 'never' ? null : v.expiresInDays,
    });
    revalidatePath('/settings/api-tokens');
    return { token: r.token };
  });
}

export async function revokeApiTokenAction(id: string) {
  return runAction(async () => {
    const r = await revokeApiToken(await getContext(), id);
    revalidatePath('/settings/api-tokens');
    return r;
  });
}
