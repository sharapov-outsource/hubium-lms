'use server';

import {
  CALENDAR_FEED_LIMITS,
  createEvent,
  deleteEvent,
  importCalendarFile,
  requireSubscription,
  resetFeedToken,
  subscribeCalendar,
  syncSubscription,
  unsubscribeCalendar,
  ValidationError,
} from '@hubium/core';
import { msg } from '@hubium/module-sdk';
import { fromZonedValue } from '@hubium/module-sdk/zoned';
import { revalidatePath } from 'next/cache';
import { getTimeZone } from 'next-intl/server';
import { formToObject, runAction } from '../action';
import { db } from '../db';
import { formFile } from '../form-files';
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
      location: v.location ?? '',
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

const target = (v: Record<string, string | undefined>) => ({
  scope: (v.scope ?? 'USER') as 'USER' | 'COURSE' | 'SITE',
  courseId: v.scope === 'COURSE' ? v.courseId || undefined : undefined,
});

/** Imports an .ics file (Import), or subscribes to a feed and fetches it (Subscribe). */
export async function importCalendarAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    if (v.source === 'url') {
      const { id } = await subscribeCalendar.run(ctx, {
        ...target(v),
        name: v.name ?? '',
        url: v.url ?? '',
        pollSeconds: Number(v.pollSeconds ?? 86_400),
      });
      // the subscription stays even when the first fetch fails: it says why and retries
      const r = await syncSubscription(db, id);
      revalidatePath('/calendar');
      return { id, events: r.events };
    }
    const file = await formFile(fd, 'file');
    if (!(file instanceof File) || !file.size)
      throw new ValidationError({ file: [msg('errors.calendar.chooseIcsFile')] });
    if (file.size > CALENDAR_FEED_LIMITS.maxBytes)
      throw new ValidationError({ file: [msg('errors.calendar.icsTooLarge')] });
    const r = await importCalendarFile.run(ctx, {
      ...target(v),
      name: v.name || file.name.replace(/\.ics$/i, ''),
      content: await file.text(),
    });
    revalidatePath('/calendar');
    return r;
  });
}

export async function refreshSubscriptionAction(id: string) {
  return runAction(async () => {
    await requireSubscription(await getContext(), id);
    const r = await syncSubscription(db, id);
    revalidatePath('/calendar');
    return r;
  });
}

export async function unsubscribeCalendarAction(id: string) {
  return runAction(async () => {
    await unsubscribeCalendar.run(await getContext(), { id });
    revalidatePath('/calendar');
    return null;
  });
}
