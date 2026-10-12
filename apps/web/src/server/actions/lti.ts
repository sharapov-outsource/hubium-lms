'use server';

import { ValidationError } from '@hubium/core';
import { rotateKey, saveTool } from '@hubium/mod-lti/server';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { formToObject, runAction } from '../action';
import { db } from '../db';
import { requireCapability } from '../session';

export async function saveLtiToolAction(fd: FormData) {
  return runAction(async () => {
    await requireCapability('site:config');
    const v = formToObject(fd);
    try {
      const tool = await saveTool(db, {
        ...v,
        sendName: fd.get('sendName') === 'on',
        sendEmail: fd.get('sendEmail') === 'on',
        enabled: fd.get('enabled') === 'on',
      });
      revalidatePath('/admin/lti');
      return { id: tool.id };
    } catch (e) {
      if (e instanceof ZodError) throw e;
      if (e instanceof Error) throw new ValidationError({ jwksUrl: [e.message] });
      throw e;
    }
  });
}

export async function deleteLtiToolAction(id: string) {
  return runAction(async () => {
    await requireCapability('site:config');
    await db.ltiTool.delete({ where: { id } });
    revalidatePath('/admin/lti');
    return null;
  });
}

export async function rotateLtiKeyAction() {
  return runAction(async () => {
    await requireCapability('site:config');
    await rotateKey(db);
    revalidatePath('/admin/lti');
    return null;
  });
}
