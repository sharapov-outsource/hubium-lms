'use server';

import { AppError, ForbiddenError } from '@hubium/core';
import { AGENT_KEY_HEADER, agentKey } from '@hubium/core/node/auth';
import { isNode, nodeConfig } from '@hubium/core/node/config';
import { acceptConflict, dismissConflict } from '@hubium/core/node/conflicts';
import {
  createNode,
  deleteNode,
  isNodeAdmin,
  newNodeCode,
  revokeNode,
  setNodeAdmin,
  updateNode,
} from '@hubium/core/node/nodes';
import { msg } from '@hubium/module-sdk';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

// Administration → Nodes (in the cloud), the conflicts of nodes' journals, and on a node the
// commands of its admins (the agent carries them out: packages/core/src/node/runtime.ts).

const nodeFields = (fd: FormData) => {
  const v = formToObject(fd);
  return { name: v.name, categoryIds: fd.getAll('categoryIds').map(String).filter(Boolean) };
};

export async function createNodeAction(fd: FormData) {
  return runAction(async () => {
    const r = await createNode.run(await getContext(), nodeFields(fd));
    revalidatePath('/admin/nodes');
    return r;
  });
}

export async function updateNodeAction(fd: FormData) {
  return runAction(async () => {
    const id = String(fd.get('id'));
    await updateNode.run(await getContext(), { ...nodeFields(fd), id });
    revalidatePath(`/admin/nodes/${id}`);
    return { id };
  });
}

export async function newNodeCodeAction(id: string) {
  return runAction(async () => {
    const r = await newNodeCode.run(await getContext(), { id });
    revalidatePath(`/admin/nodes/${id}`);
    return r;
  });
}

export async function setNodeAdminAction(
  id: string,
  userId: string,
  _role: string,
  admin: boolean,
) {
  return runAction(async () => {
    await setNodeAdmin.run(await getContext(), { id, userId, admin });
    revalidatePath(`/admin/nodes/${id}`);
    return { id };
  });
}

export async function revokeNodeAction(id: string) {
  return runAction(async () => {
    await revokeNode.run(await getContext(), { id });
    revalidatePath(`/admin/nodes/${id}`);
    return { id };
  });
}

export async function deleteNodeAction(id: string) {
  const r = await runAction(async () => deleteNode.run(await getContext(), { id }));
  if (!r.ok) return r;
  redirect('/admin/nodes');
}

export async function acceptConflictAction(id: string) {
  return runAction(async () => {
    const r = await acceptConflict.run(await getContext(), { id });
    revalidatePath(`/node-conflicts/${id}`);
    return r;
  });
}

export async function dismissConflictAction(id: string) {
  return runAction(async () => {
    await dismissConflict.run(await getContext(), { id });
    revalidatePath(`/node-conflicts/${id}`);
    return { id };
  });
}

/**
 * A node admin's command to this node's agent: work on its own now (the day of an exam on a
 * poor line), go back to the cloud, or put the sync off until the end of a lesson.
 */
export async function nodeCommandAction(action: 'offline' | 'online' | 'postpone', until?: string) {
  return runAction(async () => {
    if (!isNode()) throw new ForbiddenError(msg('errors.node.notANode'));
    const cfg = nodeConfig();
    const ctx = await getContext();
    if (!(await isNodeAdmin(ctx, cfg.id))) throw new ForbiddenError();
    const res = await fetch(`${cfg.agentUrl}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AGENT_KEY_HEADER]: agentKey(process.env.APP_SECRET ?? ''),
      },
      body: JSON.stringify({ action, until }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new AppError('UNAVAILABLE', msg('errors.node.agent'));
    revalidatePath('/node');
    return { ok: true };
  });
}
