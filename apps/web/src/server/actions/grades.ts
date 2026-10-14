'use server';

import {
  createManualItem,
  deleteGradeCategory,
  deleteManualItem,
  deleteQuestion,
  deleteQuestionCategory,
  deleteScale,
  importGift,
  importGradesCsv,
  moveGradebookEntry,
  overrideGrade,
  saveGradeCategory,
  saveLetters,
  saveQuestion,
  saveQuestionCategory,
  saveScale,
  updateGradeItem,
  ValidationError,
} from '@hubium/core';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { importMoodleXml } from '@hubium/interchange';
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
    categoryId?: string;
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

export async function saveGradeCategoryAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveGradeCategory.run(await getContext(), {
      courseId: v.courseId,
      id: v.id || undefined,
      parentId: v.parentId || undefined,
      name: v.name ?? '',
      aggregation: v.aggregation as 'NATURAL',
      dropLowest: v.dropLowest || 0,
      keepHighest: v.keepHighest || 0,
      weight: v.weight || 1,
      aggregateOnlyGraded: fd.get('aggregateOnlyGraded') === 'on',
    });
    revalidatePath(`/course/${v.courseId}/grades`);
    return r;
  });
}

export async function deleteGradeCategoryAction(courseId: string, id: string) {
  return runAction(async () => {
    const r = await deleteGradeCategory.run(await getContext(), { courseId, id });
    revalidatePath(`/course/${courseId}/grades`);
    return r;
  });
}

export async function moveGradebookEntryAction(
  courseId: string,
  kind: 'category' | 'item',
  id: string,
  direction: 'up' | 'down',
) {
  return runAction(async () => {
    const r = await moveGradebookEntry.run(await getContext(), { courseId, kind, id, direction });
    revalidatePath(`/course/${courseId}/grades`);
    return r;
  });
}

const lines = (text: string | undefined) =>
  (text ?? '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/** A course scale (with courseId) or a site scale (without). */
export async function saveScaleAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveScale.run(await getContext(), {
      id: v.id || undefined,
      courseId: v.courseId || null,
      name: v.name ?? '',
      items: lines(v.items),
    });
    revalidatePath(v.courseId ? `/course/${v.courseId}/grades` : '/admin/grades');
    return r;
  });
}

export async function deleteScaleAction(id: string, courseId: string | null) {
  return runAction(async () => {
    const r = await deleteScale.run(await getContext(), { id });
    revalidatePath(courseId ? `/course/${courseId}/grades` : '/admin/grades');
    return r;
  });
}

/**
 * Letter boundaries of a course (courseId) or of the site: rows `bound-N` / `letter-N`;
 * `inherit` clears them.
 */
export async function saveLettersAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const letters: { lowerBound: string; letter: string }[] = [];
    for (let i = 0; i < 50; i++) {
      const letter = (v[`letter-${i}`] ?? '').trim();
      const bound = (v[`bound-${i}`] ?? '').trim().replace(',', '.');
      if (letter && bound) letters.push({ lowerBound: bound, letter });
    }
    const r = await saveLetters.run(await getContext(), {
      contextId: v.courseId || SYSTEM_CONTEXT_ID,
      letters: v.inherit ? [] : (letters as never),
    });
    revalidatePath(v.courseId ? `/course/${v.courseId}/grades` : '/admin/grades');
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
    let hints: unknown;
    let sharedDatasets: unknown;
    try {
      data = JSON.parse(v.data || '{}');
      hints = v.hints ? JSON.parse(v.hints) : undefined;
      sharedDatasets = v.sharedDatasets ? JSON.parse(v.sharedDatasets) : undefined;
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
      penalty: v.penalty === undefined || v.penalty === '' ? undefined : Number(v.penalty),
      hints: hints as never,
      sharedDatasets: sharedDatasets as never,
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
    if (gift.trimStart().startsWith('<')) {
      // Moodle XML: categories come from the file itself.
      const r = await importMoodleXml(await getContext(), v.courseId ?? '', gift);
      revalidatePath(`/course/${v.courseId}/question-bank`);
      return {
        created: r.created,
        errors: [...r.errors, ...r.warnings].map((e, i) => ({
          block: i + 1,
          message: `${e.name}: ${e.message}`,
        })),
      };
    }
    const r = await importGift.run(await getContext(), {
      courseId: v.courseId,
      categoryId: v.categoryId || undefined,
      gift,
    });
    revalidatePath(`/course/${v.courseId}/question-bank`);
    return r;
  });
}
