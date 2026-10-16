'use server';

import {
  addUserRelation,
  bulkUploadUserRelations,
  listUsers,
  removeUserRelation,
  ValidationError,
} from '@hubium/core';
import { msg } from '@hubium/module-sdk';
import { decodeCsv } from '@hubium/module-sdk/csv';
import { revalidatePath } from 'next/cache';
import { runAction } from '../action';
import { formFile } from '../form-files';
import { getContext } from '../session';

// Administration: linking mentors and parents to the users they follow.

/** People to pick in administration (a mentor, a category's role holder), by name or email. */
export async function searchUsersAction(q: string) {
  return runAction(async () => {
    if (q.trim().length < 2) return [];
    const { items } = await listUsers(await getContext(), { q: q.trim(), pageSize: 10 });
    return items.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.emailPlaceholder ? null : u.email,
    }));
  });
}

export async function addUserRelationAction(
  mentorId: string,
  menteeId: string,
  kind: 'PARENT' | 'MENTOR',
) {
  return runAction(async () => {
    const r = await addUserRelation.run(await getContext(), { mentorId, menteeId, kind });
    revalidatePath(`/admin/users/${menteeId}`);
    revalidatePath(`/admin/users/${mentorId}`);
    return r;
  });
}

export async function removeUserRelationAction(mentorId: string, menteeId: string) {
  return runAction(async () => {
    const r = await removeUserRelation.run(await getContext(), { mentorId, menteeId });
    revalidatePath(`/admin/users/${menteeId}`);
    revalidatePath(`/admin/users/${mentorId}`);
    return r;
  });
}

export async function uploadRelationsAction(fd: FormData) {
  return runAction(async () => {
    const file = await formFile(fd, 'file');
    if (!(file instanceof File) || file.size === 0)
      throw new ValidationError({ file: [msg('errors.common.chooseCsv')] });
    const csv = decodeCsv(new Uint8Array(await file.arrayBuffer()));
    return bulkUploadUserRelations.run(await getContext(), { csv });
  });
}
