'use server';

import {
  deleteCourseField,
  localizedFromForm,
  moveCourseField,
  saveCourseField,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formBool, formToObject, runAction } from '../action';
import { getContext } from '../session';

export async function saveCourseFieldAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveCourseField.run(await getContext(), {
      id: v.id || undefined,
      shortName: v.shortName,
      name: localizedFromForm(v, 'name'),
      type: v.type,
      choices: (v.choices ?? '')
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean),
      required: formBool(fd.get('required')),
      locked: formBool(fd.get('locked')),
      visible: formBool(fd.get('visible')),
    });
    revalidatePath('/admin/course-fields');
    return r;
  });
}

export async function courseFieldCommandAction(id: string, cmd: 'up' | 'down' | 'delete') {
  return runAction(async () => {
    const ctx = await getContext();
    if (cmd === 'delete') await deleteCourseField.run(ctx, { id });
    else await moveCourseField.run(ctx, { id, direction: cmd });
    revalidatePath('/admin/course-fields');
    return null;
  });
}
