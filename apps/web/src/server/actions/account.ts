'use server';

import {
  addRecoveryPassphrase,
  assertPasswordAllowed,
  deleteRecoveryPassphrase,
  listProfileFields,
  profileValuesFromForm,
  ValidationError,
  validateProfileValues,
  writeProfileValues,
} from '@hubium/core';
import { APIError } from 'better-auth/api';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import { formToObject, runAction } from '../action';
import { auth } from '../auth';
import { db } from '../db';
import { getContext, requireUser } from '../session';

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
    const form = formToObject(fd);
    const r = ProfileInput.safeParse(form);
    if (!r.success) throw r.error;
    const { firstName, lastName, timezone } = r.data;
    if (timezone && !validTimezone(timezone))
      throw new ValidationError({ timezone: ['Unknown time zone'] });
    // custom profile fields the person may change themselves
    const fields = (await listProfileFields(db)).filter((f) => !f.locked);
    const custom = validateProfileValues(fields, profileValuesFromForm(fields, form), {
      requireAll: true,
    });
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { firstName, lastName, name: `${firstName} ${lastName}`, timezone: timezone || null },
      });
      await writeProfileValues(tx, user.id, custom);
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
  return runAction(
    async () => {
      const user = await requireUser();
      const v = formToObject(fd);
      await assertPasswordAllowed(db, v.newPassword ?? '', {
        userId: user.id,
        field: 'newPassword',
      });
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
      } catch (e) {
        if (e instanceof APIError && e.body?.code === 'PASSWORD_POLICY') throw e;
        throw new ValidationError({ currentPassword: ['Invalid password'] });
      }
      await db.user.update({
        where: { id: user.id },
        data: { mustChangePassword: false },
      });
      return null;
    },
    { duringGate: true },
  );
}

/** Signs out one of the person's other sessions, named by id: tokens never reach the page. */
export async function revokeSessionAction(id: string) {
  return runAction(
    async () => {
      const user = await requireUser();
      const session = await db.session.findFirst({
        where: { id, userId: user.id },
        select: { token: true },
      });
      if (session)
        await auth.api.revokeSession({ body: { token: session.token }, headers: await headers() });
      revalidatePath('/settings/security');
      return null;
    },
    { duringGate: true },
  );
}

export async function revokeOtherSessionsAction() {
  return runAction(
    async () => {
      await requireUser();
      await auth.api.revokeOtherSessions({ headers: await headers() });
      revalidatePath('/settings/security');
      return null;
    },
    { duringGate: true },
  );
}

export async function addRecoveryPassphraseAction(fd: FormData) {
  return runAction(
    async () => {
      const v = formToObject(fd);
      if (v.passphrase !== v.passphrase2)
        throw new ValidationError({ passphrase2: ['Phrases do not match'] });
      await addRecoveryPassphrase.run(await getContext(), {
        name: v.name ?? '',
        passphrase: v.passphrase ?? '',
        password: v.password ?? '',
        code: v.code ?? '',
      });
      revalidatePath('/settings/security');
      return null;
    },
    { duringGate: true },
  );
}

export async function deleteRecoveryPassphraseAction(id: string) {
  return runAction(
    async () => {
      await deleteRecoveryPassphrase.run(await getContext(), { id });
      revalidatePath('/settings/security');
      return null;
    },
    { duringGate: true },
  );
}
