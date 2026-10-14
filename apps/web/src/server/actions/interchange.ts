'use server';

import { ForbiddenError, NotFoundError, ValidationError } from '@hubium/core';
import {
  duplicateCourse,
  importActivities,
  type RestoreReport,
  startImport,
} from '@hubium/interchange';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

export async function duplicateCourseAction(fd: FormData) {
  const v = formToObject(fd);
  const res = await runAction(async () => {
    if (!v.fullName?.trim()) throw new ValidationError({ fullName: ['Required'] });
    if (!v.shortName?.trim()) throw new ValidationError({ shortName: ['Required'] });
    return duplicateCourse(await getContext(), v.courseId!, {
      categoryId: v.categoryId || undefined,
      fullName: v.fullName.trim(),
      shortName: v.shortName.trim(),
    });
  });
  if (res.ok) {
    revalidatePath('/my-courses');
    redirect(`/course/${res.data.courseId}`);
  }
  return res;
}

/** Copies chosen activities of another course into this one. */
export async function importActivitiesAction(input: {
  targetCourseId: string;
  sourceCourseId: string;
  activityIds: string[];
}) {
  const res = await runAction(async () => importActivities(await getContext(), input));
  if (res.ok) revalidatePath(`/course/${input.targetCourseId}`);
  return res;
}

export async function startImportAction(input: {
  uploadId: string;
  categoryId: string;
  kind: 'hubium' | 'mbz';
}) {
  return runAction(async () => {
    const ctx = await getContext();
    if (ctx.actor.kind !== 'user') throw new ForbiddenError();
    const cap = input.kind === 'mbz' ? 'import:moodle' : 'restore:course';
    await ctx.perm.require('course:create', input.categoryId);
    await ctx.perm.require(cap, input.categoryId);
    return { taskId: await startImport(ctx.db, ctx.actor.userId, input) };
  });
}

export async function importStatusAction(taskId: string) {
  return runAction(async () => {
    const ctx = await getContext();
    if (ctx.actor.kind !== 'user') throw new ForbiddenError();
    const task = await ctx.db.backgroundTask.findFirst({
      where: { id: taskId, createdById: ctx.actor.userId },
      select: { status: true, progress: true, result: true, error: true },
    });
    if (!task) throw new NotFoundError();
    return task as {
      status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
      progress: number;
      result: RestoreReport | null;
      error: string | null;
    };
  });
}
