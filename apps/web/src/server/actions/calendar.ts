'use server';

import { createEvent, deleteEvent, resetFeedToken } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { db } from '../db';
import { getContext, requireUser } from '../session';

export async function createEventAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const allDay = fd.get('allDay') === 'on';
    // datetime-local has no zone: interpret it in the browser's offset (minutes, as getTimezoneOffset).
    const offset = Number(v.tzOffset ?? 0) || 0;
    const local = (x?: string) =>
      x ? new Date(new Date(`${x}Z`).getTime() + offset * 60_000).toISOString() : null;
    const r = await createEvent.run(await getContext(), {
      scope: v.scope,
      courseId: v.courseId || undefined,
      title: v.title,
      description: v.description ?? '',
      startsAt: allDay ? `${(v.startsAt ?? '').slice(0, 10)}T00:00:00Z` : (local(v.startsAt) ?? ''),
      endsAt: local(v.endsAt || undefined),
      allDay,
    });
    revalidatePath('/calendar');
    return r;
  });
}

export async function deleteEventAction(id: string) {
  return runAction(async () => {
    await deleteEvent.run(await getContext(), { id });
    revalidatePath('/calendar');
    return null;
  });
}

export async function resetFeedTokenAction() {
  return runAction(async () => {
    const user = await requireUser();
    return { token: await resetFeedToken(db, user.id) };
  });
}
