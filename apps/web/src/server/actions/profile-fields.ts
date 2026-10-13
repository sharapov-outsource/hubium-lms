'use server';

import { deleteProfileField, moveProfileField, saveProfileField } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

const bool = (v: FormDataEntryValue | null) => v === 'on' || v === 'true' || v === '1';

export async function saveProfileFieldAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveProfileField.run(await getContext(), {
      id: v.id || undefined,
      shortName: v.shortName,
      name: { ru: v.nameRu, en: v.nameEn },
      type: v.type,
      choices: (v.choices ?? '')
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean),
      required: bool(fd.get('required')),
      locked: bool(fd.get('locked')),
      visibleToOthers: bool(fd.get('visibleToOthers')),
    });
    revalidatePath('/admin/profile-fields');
    return r;
  });
}

export async function profileFieldCommandAction(id: string, cmd: 'up' | 'down' | 'delete') {
  return runAction(async () => {
    const ctx = await getContext();
    if (cmd === 'delete') await deleteProfileField.run(ctx, { id });
    else await moveProfileField.run(ctx, { id, direction: cmd });
    revalidatePath('/admin/profile-fields');
    return null;
  });
}
