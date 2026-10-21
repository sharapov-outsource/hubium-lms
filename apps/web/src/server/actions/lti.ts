'use server';

import {
  assertModuleEnabled,
  defineOperation,
  logEvent,
  type RequestContext,
  ValidationError,
} from '@hubium/core';
import { rotateKey, saveTool } from '@hubium/mod-lti/server';
import { UnsafeUrlError } from '@hubium/module-sdk/net';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

// The site's LTI tools, as operations: the core cannot import the module, so they are
// defined here, with the same permission check and an entry in the event log.

const siteLti = async (ctx: RequestContext) => {
  await ctx.perm.require('site:config');
  await assertModuleEnabled(ctx.db, 'lti');
};

const saveLtiTool = defineOperation({
  name: 'lti.tool.save',
  input: z.record(z.string(), z.unknown()),
  authorize: siteLti,
  async handler(ctx, input) {
    try {
      const tool = await saveTool(ctx.tx, input);
      await logEvent(ctx.tx, {
        name: input.id ? 'lti.tool.updated' : 'lti.tool.created',
        actorId: ctx.perm.userId,
        objectType: 'LtiTool',
        objectId: tool.id,
        data: { name: tool.name },
      });
      return { id: tool.id };
    } catch (e) {
      // an address the server may not fetch is said under the field; anything else as it is
      if (e instanceof UnsafeUrlError) throw new ValidationError({ jwksUrl: [e.msg] });
      throw e;
    }
  },
});

const deleteLtiTool = defineOperation({
  name: 'lti.tool.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, { id }) {
    const tool = await ctx.tx.ltiTool.delete({ where: { id }, select: { id: true, name: true } });
    await logEvent(ctx.tx, {
      name: 'lti.tool.deleted',
      actorId: ctx.perm.userId,
      objectType: 'LtiTool',
      objectId: tool.id,
      data: { name: tool.name },
    });
    return null;
  },
});

const rotateLtiKey = defineOperation({
  name: 'lti.key.rotate',
  input: z.object({}),
  authorize: siteLti,
  // the old key retires only with the new one made
  async handler(ctx) {
    const kid = await rotateKey(ctx.tx);
    await logEvent(ctx.tx, { name: 'lti.key.rotated', actorId: ctx.perm.userId, data: { kid } });
    return null;
  },
});

export async function saveLtiToolAction(fd: FormData) {
  return runAction(async () => {
    const r = await saveLtiTool.run(await getContext(), {
      ...formToObject(fd),
      sendName: fd.get('sendName') === 'on',
      sendEmail: fd.get('sendEmail') === 'on',
      enabled: fd.get('enabled') === 'on',
    });
    revalidatePath('/admin/lti');
    return r;
  });
}

export async function deleteLtiToolAction(id: string) {
  return runAction(async () => {
    await deleteLtiTool.run(await getContext(), { id });
    revalidatePath('/admin/lti');
    return null;
  });
}

export async function rotateLtiKeyAction() {
  return runAction(async () => {
    await rotateLtiKey.run(await getContext(), {});
    revalidatePath('/admin/lti');
    return null;
  });
}
