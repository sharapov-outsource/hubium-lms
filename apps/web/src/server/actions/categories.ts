'use server';

import { createCategory, deleteCategory, moveCategoryOrder, updateCategory } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formBool, formToObject, runAction } from '../action';
import { getContext } from '../session';

// Administration → Course categories.

export async function saveCategoryAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    const input = {
      name: v.name,
      description: v.description ?? '',
      idNumber: v.idNumber,
      parentId: v.parentId || null,
      visible: formBool(fd.get('visible')),
    };
    const r = v.id
      ? await updateCategory.run(ctx, { id: v.id, ...input })
      : await createCategory.run(ctx, input);
    revalidatePath('/admin/categories');
    return r;
  });
}

export async function categoryCommandAction(id: string, cmd: 'up' | 'down' | 'delete') {
  return runAction(async () => {
    const ctx = await getContext();
    if (cmd === 'delete') await deleteCategory.run(ctx, { id });
    else await moveCategoryOrder.run(ctx, { id, direction: cmd });
    revalidatePath('/admin/categories');
    return null;
  });
}
