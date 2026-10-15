'use server';

import {
  createCohort,
  deleteCohort,
  importCohorts,
  resolveLogins,
  setCohortMembers,
  ValidationError,
} from '@hubium/core';
import { msg } from '@hubium/module-sdk';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

// Administration → Cohorts.

export async function saveCohortAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await createCohort.run(await getContext(), {
      name: v.name,
      idNumber: v.idNumber,
      description: v.description ?? '',
    });
    revalidatePath('/admin/cohorts');
    return r;
  });
}

export async function cohortMembersAction(cohortId: string, add: string[], remove: string[]) {
  return runAction(async () => {
    await setCohortMembers.run(await getContext(), { cohortId, add, remove });
    revalidatePath('/admin/cohorts', 'layout');
    return null;
  });
}

export async function addCohortMemberByLoginAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    const add = await resolveLogins(ctx, v.login, {
      allowed: () => ctx.perm.require('cohort:manage'),
      field: 'login',
    });
    if (!add.length) throw new ValidationError({ login: [msg('errors.common.userNotFound')] });
    await setCohortMembers.run(ctx, { cohortId: v.cohortId, add, remove: [] });
    revalidatePath('/admin/cohorts', 'layout');
    return null;
  });
}

export async function deleteCohortAction(id: string) {
  return runAction(async () => {
    await deleteCohort.run(await getContext(), { id });
    revalidatePath('/admin/cohorts', 'layout');
    return null;
  });
}

/** Cohorts from a CSV file; `apply` false only checks it. */
export async function importCohortsAction(csv: string, apply: boolean) {
  return runAction(async () => {
    const r = await importCohorts.run(await getContext(), { csv, apply });
    if (apply) revalidatePath('/admin/cohorts');
    return r;
  });
}
