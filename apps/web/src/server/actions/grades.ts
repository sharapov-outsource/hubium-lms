'use server';

import {
  createManualItem,
  deleteManualItem,
  deleteQuestion,
  deleteQuestionCategory,
  importGift,
  importGradesCsv,
  overrideGrade,
  saveGradeCategory,
  saveQuestion,
  saveQuestionCategory,
  updateGradeItem,
  ValidationError,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

export async function overrideGradeAction(
  courseId: string,
  itemId: string,
  userId: string,
  value: number | null,
) {
  return runAction(async () => {
    const r = await overrideGrade.run(await getContext(), { itemId, userId, value });
    revalidatePath(`/course/${courseId}/grades`);
    return r;
  });
}

export async function createManualItemAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await createManualItem.run(await getContext(), v as never);
    revalidatePath(`/course/${v.courseId}/grades`);
    return r;
  });
}

export async function updateGradeItemAction(
  courseId: string,
  id: string,
  patch: {
    weight?: number;
    hidden?: boolean;
    locked?: boolean;
    display?: 'REAL' | 'PERCENT' | 'LETTER';
  },
) {
  return runAction(async () => {
    const r = await updateGradeItem.run(await getContext(), { id, ...patch });
    revalidatePath(`/course/${courseId}/grades`);
    return r;
  });
}

export async function deleteGradeItemAction(courseId: string, id: string) {
  return runAction(async () => {
    const r = await deleteManualItem.run(await getContext(), { id });
    revalidatePath(`/course/${courseId}/grades`);
    return r;
  });
}

export async function saveAggregationAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveGradeCategory.run(await getContext(), {
      courseId: v.courseId,
      id: v.id,
      aggregation: v.aggregation as 'NATURAL',
      dropLowest: v.dropLowest,
      aggregateOnlyGraded: fd.get('aggregateOnlyGraded') === 'on',
    });
    revalidatePath(`/course/${v.courseId}/grades`);
    return r;
  });
}

export async function importGradesAction(fd: FormData) {
  return runAction(async () => {
    const courseId = String(fd.get('courseId'));
    const file = fd.get('file');
    if (!(file instanceof File) || !file.size)
      throw new ValidationError({ file: ['Choose a CSV file'] });
    const r = await importGradesCsv.run(await getContext(), {
      courseId,
      csv: Buffer.from(await file.arrayBuffer()).toString('utf8'),
    });
    revalidatePath(`/course/${courseId}/grades`);
    return r;
  });
}

// ── question bank ─────────────────────────────────────────────────────────────

export async function saveQuestionCategoryAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveQuestionCategory.run(await getContext(), {
      courseId: v.courseId,
      id: v.id || undefined,
      name: v.name,
      parentId: v.parentId,
    });
    revalidatePath(`/course/${v.courseId}/question-bank`);
    return r;
  });
}

export async function deleteQuestionCategoryAction(courseId: string, id: string) {
  return runAction(async () => {
    await deleteQuestionCategory.run(await getContext(), { id });
    revalidatePath(`/course/${courseId}/question-bank`);
    return null;
  });
}

export async function saveQuestionAction(fd: FormData) {
  const v = formToObject(fd);
  const res = await runAction(async () => {
    let data: unknown;
    try {
      data = JSON.parse(v.data || '{}');
    } catch {
      throw new ValidationError({ data: ['Invalid data'] });
    }
    return saveQuestion.run(await getContext(), {
      id: v.id || undefined,
      categoryId: v.categoryId,
      type: v.type as 'ESSAY',
      name: v.name,
      text: v.text ?? '',
      generalFeedback: v.generalFeedback ?? '',
      defaultMark: v.defaultMark,
      status: (v.status || 'READY') as 'READY',
      data,
    });
  });
  if (res.ok) redirect(`/course/${v.courseId}/question-bank?category=${v.categoryId}`);
  return res;
}

export async function deleteQuestionAction(courseId: string, id: string) {
  return runAction(async () => {
    const r = await deleteQuestion.run(await getContext(), { id });
    revalidatePath(`/course/${courseId}/question-bank`);
    return r;
  });
}

export async function importGiftAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    let gift = v.gift ?? '';
    const file = fd.get('file');
    if (file instanceof File && file.size)
      gift = Buffer.from(await file.arrayBuffer()).toString('utf8');
    if (!gift.trim()) throw new ValidationError({ gift: ['Paste GIFT text or choose a file'] });
    const r = await importGift.run(await getContext(), {
      courseId: v.courseId,
      categoryId: v.categoryId || undefined,
      gift,
    });
    revalidatePath(`/course/${v.courseId}/question-bank`);
    return r;
  });
}
