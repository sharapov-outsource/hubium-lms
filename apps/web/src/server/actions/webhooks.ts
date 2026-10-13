'use server';

import {
  createWebhook,
  deleteWebhook,
  pingWebhook,
  redeliverWebhook,
  rotateWebhookSecret,
  updateWebhook,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

const fields = (fd: FormData) => {
  const v = formToObject(fd);
  return { name: v.name, url: v.url, events: fd.getAll('events').map(String) };
};

export async function createWebhookAction(fd: FormData) {
  return runAction(async () => {
    const w = await createWebhook.run(await getContext(), { ...fields(fd), enabled: true });
    revalidatePath('/admin/webhooks');
    return { id: w.id, secret: w.secret };
  });
}

export async function updateWebhookAction(fd: FormData) {
  return runAction(async () => {
    const w = await updateWebhook.run(await getContext(), {
      ...fields(fd),
      id: String(fd.get('id')),
      enabled: fd.get('enabled') === 'on',
    });
    revalidatePath(`/admin/webhooks/${w.id}`);
    return { id: w.id };
  });
}

export async function deleteWebhookAction(id: string) {
  const r = await runAction(async () => deleteWebhook.run(await getContext(), { id }));
  if (!r.ok) return r;
  redirect('/admin/webhooks');
}

export async function rotateWebhookSecretAction(id: string) {
  return runAction(async () => rotateWebhookSecret.run(await getContext(), { id }));
}

export async function pingWebhookAction(id: string) {
  return runAction(async () => {
    const r = await pingWebhook.run(await getContext(), { id });
    revalidatePath(`/admin/webhooks/${id}`);
    return r;
  });
}

export async function redeliverWebhookAction(deliveryId: string, webhookId: string) {
  return runAction(async () => {
    const r = await redeliverWebhook.run(await getContext(), { deliveryId });
    revalidatePath(`/admin/webhooks/${webhookId}`);
    return r;
  });
}
