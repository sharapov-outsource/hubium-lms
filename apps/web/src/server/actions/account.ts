'use server';

import { ValidationError } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import { formToObject, runAction } from '../action';
import { auth } from '../auth';
import { db } from '../db';
import { requireUser } from '../session';

const ProfileInput = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  timezone: z.string().trim().max(64).optional(),
});

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function updateProfileAction(fd: FormData) {
  return runAction(async () => {
    const user = await requireUser();
    const r = ProfileInput.safeParse(formToObject(fd));
    if (!r.success) throw r.error;
    const { firstName, lastName, timezone } = r.data;
    if (timezone && !validTimezone(timezone))
      throw new ValidationError({ timezone: ['Unknown time zone'] });
    await db.user.update({
      where: { id: user.id },
      data: { firstName, lastName, name: `${firstName} ${lastName}`, timezone: timezone || null },
    });
    revalidatePath('/', 'layout');
    return null;
  });
}

export async function changeEmailAction(fd: FormData) {
  return runAction(async () => {
    await requireUser();
    const email = z.string().trim().toLowerCase().email().parse(fd.get('email'));
    await auth.api.changeEmail({
      body: { newEmail: email, callbackURL: '/settings/account' },
      headers: await headers(),
    });
    return null;
  });
}

export async function changePasswordAction(fd: FormData) {
  return runAction(async () => {
    await requireUser();
    const v = formToObject(fd);
    if ((v.newPassword ?? '').length < 8)
      throw new ValidationError({ newPassword: ['At least 8 characters'] });
    if (v.newPassword !== v.newPassword2)
      throw new ValidationError({ newPassword2: ['Passwords do not match'] });
    try {
      await auth.api.changePassword({
        body: {
          currentPassword: v.currentPassword ?? '',
          newPassword: v.newPassword!,
          revokeOtherSessions: true,
        },
        headers: await headers(),
      });
    } catch {
      throw new ValidationError({ currentPassword: ['Invalid password'] });
    }
    await db.user.update({
      where: { id: (await requireUser()).id },
      data: { mustChangePassword: false },
    });
    return null;
  });
}

export async function revokeSessionAction(token: string) {
  return runAction(async () => {
    await requireUser();
    await auth.api.revokeSession({ body: { token }, headers: await headers() });
    revalidatePath('/settings/security');
    return null;
  });
}

export async function revokeOtherSessionsAction() {
  return runAction(async () => {
    await requireUser();
    await auth.api.revokeOtherSessions({ headers: await headers() });
    revalidatePath('/settings/security');
    return null;
  });
}
