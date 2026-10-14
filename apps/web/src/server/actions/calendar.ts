'use server';

import { createEvent, deleteEvent, resetFeedToken } from '@hubium/core';
import { fromZonedValue } from '@hubium/module-sdk/zoned';
import { revalidatePath } from 'next/cache';
import { getTimeZone } from 'next-intl/server';
import { formToObject, runAction } from '../action';
import { db } from '../db';
import { getContext, requireUser } from '../session';

export async function createEventAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const allDay = fd.get('allDay') === 'on';
    // the picker holds a wall-clock time in the user's zone, the one the calendar shows
    const timeZone = await getTimeZone();
    const local = (x?: string) => fromZonedValue(x, timeZone) || null;
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
