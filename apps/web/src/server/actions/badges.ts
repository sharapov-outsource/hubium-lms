'use server';

import {
  awardBadgeAgain,
  checkBadgeImage,
  deleteBadge,
  markBadge,
  requireBadgeAward,
  resolveLogins,
  revokeBadgeAward,
  saveBadge,
  saveBadgeIssuer,
  setBadgeImage,
  setBadgeStatus,
  ValidationError,
} from '@hubium/core';
import { msg } from '@hubium/module-sdk';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

const pathOf = (courseId: string | null | undefined) =>
  courseId ? `/course/${courseId}/badges` : '/admin/badges';

/** Saves a badge, and its image when one was chosen. */
export async function saveBadgeAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    let criteria: unknown = {};
    try {
      criteria = JSON.parse(v.criteria ?? '{}');
    } catch {
      throw new ValidationError({ criteria: [msg('errors.badges.invalidCriteria')] });
    }
    // the image is checked first: a refused image must not leave a new badge behind
    const image = fd.get('image');
    const data =
      image instanceof File && image.size ? new Uint8Array(await image.arrayBuffer()) : null;
    if (data) checkBadgeImage(data);
    const r = await saveBadge.run(ctx, {
      id: v.id || undefined,
      courseId: v.courseId || null,
      name: v.name ?? '',
      description: v.description ?? '',
      criteria,
      expiry: (v.expiry ?? 'never') as 'never' | 'days' | 'date',
      expiresAfterDays: v.expiresAfterDays || undefined,
      expiresAt: v.expiresAt || undefined,
    });
    if (data && image instanceof File)
      await setBadgeImage.run(ctx, { id: r.id, name: image.name, data });
    revalidatePath(pathOf(v.courseId));
    return r;
  });
}

export async function setBadgeStatusAction(
  courseId: string | null,
  id: string,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
) {
  return runAction(async () => {
    await setBadgeStatus.run(await getContext(), { id, status });
    revalidatePath(pathOf(courseId), 'layout');
    return null;
  });
}

export async function deleteBadgeAction(courseId: string | null, id: string) {
  return runAction(async () => {
    await deleteBadge.run(await getContext(), { id });
    revalidatePath(pathOf(courseId));
    return null;
  });
}

/** Awards a badge by hand to a learner chosen from the list, or (site badges) by login. */
export async function markBadgeAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    let userId = v.userId ?? '';
    if (!userId && v.login !== undefined) {
      const [id] = await resolveLogins(ctx, v.login, {
        allowed: () => requireBadgeAward(ctx, v.badgeId ?? ''),
        field: 'login',
      });
      if (!id) throw new ValidationError({ login: [msg('errors.common.userNotFound')] });
      userId = id;
    }
    const r = await markBadge.run(ctx, { badgeId: v.badgeId ?? '', userId });
    revalidatePath(pathOf(v.courseId), 'layout');
    return r;
  });
}

/** Gives a revoked or expired award again. */
export async function awardBadgeAgainAction(courseId: string | null, awardId: string) {
  return runAction(async () => {
    await awardBadgeAgain.run(await getContext(), { awardId });
    revalidatePath(pathOf(courseId), 'layout');
    return null;
  });
}

export async function revokeBadgeAwardAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await revokeBadgeAward.run(await getContext(), {
      awardId: v.awardId ?? '',
      reason: v.reason ?? '',
    });
    revalidatePath(pathOf(v.courseId), 'layout');
    return null;
  });
}

export async function saveBadgeIssuerAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await saveBadgeIssuer.run(await getContext(), { name: v.name ?? '', email: v.email ?? '' });
    revalidatePath('/admin/badges');
    return null;
  });
}
