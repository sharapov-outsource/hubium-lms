'use server';

import {
  addSection,
  buildModuleCtx,
  createActivity,
  createCourse,
  deleteActivity,
  deleteCourse,
  deleteSection,
  isSwitchableRole,
  moveActivity,
  moveActivityStep,
  moveSection,
  moveSubsection,
  overrideCompletion,
  profileValuesFromForm,
  purgeActivity,
  purgeCourse,
  type RequestContext,
  resetCourse,
  restoreActivity,
  restoreCourse,
  setActivityVisibility,
  setCourseImage,
  setSectionVisible,
  toggleManualCompletion,
  updateActivity,
  updateCourse,
  updateSection,
  ValidationError,
} from '@hubium/core';
import { checkFile, storeFile } from '@hubium/core/files/files';
import { checkUpload } from '@hubium/core/files/uploads';
import { duplicateActivity } from '@hubium/interchange';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { safePath } from '@/lib/safe-path';
import { formBool, formToObject, runAction } from '../action';
import { courseFieldViews } from '../course-fields';
import { db } from '../db';
import { formFile, formFiles } from '../form-files';
import { freshContext, getContext, VIEW_AS_COOKIE } from '../session';

function courseFormValues(fd: FormData) {
  const v = formToObject(fd);
  return {
    categoryId: v.categoryId,
    fullName: v.fullName,
    shortName: v.shortName,
    idNumber: v.idNumber,
    summary: v.summary ?? '',
    format: v.format,
    sections: v.sections,
    startDate: v.startDate || null,
    endDate: v.endDate || null,
    visible: formBool(fd.get('visible')),
    lang: v.lang || null,
    enableCompletion: formBool(fd.get('enableCompletion')),
    groupMode: v.groupMode,
    groupModeForced: formBool(fd.get('groupModeForced')),
    guestAccess: formBool(fd.get('guestAccess')),
  };
}

const COVER = { maxBytes: 5 * 1024 * 1024, allowedTypes: /^image\/(png|jpeg|webp|gif)$/ };

/** Checks a file of the form, its refusal shown at the form's own input. */
async function checkFormFile(
  field: string,
  file: Parameters<typeof checkFile>[1] | (() => Promise<void>),
) {
  try {
    await (typeof file === 'function' ? file() : checkFile(db, file));
  } catch (e) {
    if (e instanceof ValidationError)
      throw new ValidationError({ [field]: Object.values(e.fieldMessages ?? {}).flat() });
    throw e;
  }
}

/** The cover from the form, checked (size, type, malware) before the course is saved. */
async function courseImage(fd: FormData) {
  const image = await formFile(fd, 'image');
  if (!(image instanceof File) || image.size === 0) return null;
  const file = {
    name: image.name,
    mimeType: image.type,
    data: Buffer.from(await image.arrayBuffer()),
  };
  await checkFormFile('image', { ...file, ...COVER });
  return file;
}

async function saveCourseImage(
  ctx: RequestContext,
  courseId: string,
  image: Awaited<ReturnType<typeof courseImage>>,
) {
  if (!image) return;
  const f = await storeFile(db, {
    contextId: courseId,
    component: 'course',
    area: 'image',
    ...image,
    ...COVER,
    uploadedById: ctx.perm.userId,
    replace: true,
  });
  await setCourseImage(ctx, courseId, f.id);
}

/** Values of the custom course fields the person may change in the form. */
async function customFieldValues(fd: FormData, contextId: string) {
  const editable = (await courseFieldViews(await getContext(), 'en', contextId)).filter(
    (f) => !f.readOnly,
  );
  return editable.length ? profileValuesFromForm(editable, formToObject(fd)) : undefined;
}

export async function createCourseAction(fd: FormData) {
  const res = await runAction(async () => {
    const values = courseFormValues(fd);
    const image = await courseImage(fd);
    const r = await createCourse.run(await getContext(), {
      ...values,
      customFields: await customFieldValues(fd, values.categoryId ?? ''),
    });
    // the author's role in the new course is not in the request's permissions yet
    await saveCourseImage(await freshContext(), r.id, image);
    return r;
  });
  if (res.ok) redirect(`/course/${res.data.id}?edit=1`);
  return res;
}

export async function updateCourseAction(fd: FormData) {
  return runAction(async () => {
    const id = String(fd.get('id'));
    const image = await courseImage(fd);
    const r = await updateCourse.run(await getContext(), {
      id,
      ...courseFormValues(fd),
      customFields: await customFieldValues(fd, id),
    });
    await saveCourseImage(await getContext(), id, image);
    if (formBool(fd.get('removeImage'))) await setCourseImage(await getContext(), id, null);
    revalidatePath(`/course/${id}`, 'layout');
    return r;
  });
}

export async function deleteCourseAction(id: string) {
  const res = await runAction(async () => deleteCourse.run(await getContext(), { id }));
  if (res.ok) redirect('/my-courses');
  return res;
}

export async function purgeCourseAction(id: string) {
  return runAction(async () => {
    const r = await purgeCourse.run(await getContext(), { id });
    revalidatePath('/admin/courses');
    return r;
  });
}

export async function restoreCourseAction(id: string) {
  return runAction(async () => {
    const r = await restoreCourse.run(await getContext(), { id });
    revalidatePath('/admin/courses');
    return r;
  });
}

// ── sections ──────────────────────────────────────────────────────────────────

export async function addSectionAction(
  courseId: string,
  opts: { afterSectionId?: string; parentId?: string; title?: string } = {},
) {
  return runAction(async () => {
    const r = await addSection.run(await getContext(), { courseId, ...opts });
    revalidatePath(`/course/${courseId}`);
    return r;
  });
}

/** Moves a subsection to the end of another section. */
export async function moveSubsectionAction(courseId: string, id: string, parentId: string) {
  return runAction(async () => {
    await moveSubsection.run(await getContext(), { id, parentId });
    revalidatePath(`/course/${courseId}`);
    return null;
  });
}

export async function updateSectionAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await updateSection.run(await getContext(), {
      id: v.id,
      title: v.title ?? '',
      summary: v.summary ?? '',
      // a form without the restrictions editor leaves them as they are
      availability: fd.has('availability') ? (v.availability ?? null) : undefined,
    });
    revalidatePath(`/course/${v.courseId}`);
    return r;
  });
}

export async function sectionCommandAction(
  courseId: string,
  id: string,
  cmd: 'show' | 'hide' | 'up' | 'down' | 'delete',
) {
  return runAction(async () => {
    const ctx = await getContext();
    if (cmd === 'show' || cmd === 'hide')
      await setSectionVisible.run(ctx, { id, visible: cmd === 'show' });
    else if (cmd === 'up' || cmd === 'down') await moveSection.run(ctx, { id, direction: cmd });
    else await deleteSection.run(ctx, { id });
    revalidatePath(`/course/${courseId}`);
    return null;
  });
}

// ── activities ────────────────────────────────────────────────────────────────

/** Collects "settings.*" fields into an object; repeated keys become arrays, checkboxes booleans. */
function collectSettings(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith('settings.') || typeof v !== 'string') continue;
    const key = k.slice('settings.'.length);
    const value: unknown = v === 'on' ? true : v;
    if (key in out)
      out[key] = Array.isArray(out[key]) ? [...(out[key] as unknown[]), value] : [out[key], value];
    else out[key] = value;
  }
  // Unchecked checkboxes are absent: modules declare them with `settings.__bool=<name>`.
  for (const b of fd.getAll('settings.__bool')) {
    const name = String(b);
    if (!(name in out)) out[name] = false;
  }
  delete out.__bool;
  return out;
}

function collectCompletionRules(fd: FormData) {
  const module: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith('completion.') && typeof v === 'string' && v !== '')
      module[k.slice('completion.'.length)] = v === 'on' ? true : v;
  }
  return { view: formBool(fd.get('completionView')), module };
}

const ACTIVITY_FILE_BYTES = 200 * 1024 * 1024;

/** The form's files, checked (size, type, malware) before the activity is saved: a file the
 *  check refuses leaves no activity without it behind, to be made twice on the next try. */
async function checkActivityFiles(fd: FormData) {
  const ctx = await getContext();
  for (const f of formFiles(fd, isActivityFile)) {
    if (f.file)
      await checkFormFile(f.field, {
        name: f.file.name,
        mimeType: f.file.type,
        data: Buffer.from(await f.file.arrayBuffer()),
        maxBytes: ACTIVITY_FILE_BYTES,
      });
    else
      await checkFormFile(f.field, () =>
        checkUpload(db, ctx.perm.userId ?? '', f.uploadId, { maxBytes: ACTIVITY_FILE_BYTES }),
      );
  }
}

const isActivityFile = (k: string) => k.startsWith('files.') && k !== 'files.remove';

async function saveActivityFiles(activityId: string, fd: FormData) {
  const ctx = await getContext();
  const mctx = buildModuleCtx(ctx);
  const remove = fd.getAll('files.remove').map(String);
  for (const f of formFiles(fd, isActivityFile)) {
    const area = f.field.slice('files.'.length);
    if (f.file)
      await mctx.files.store(
        activityId,
        area,
        { name: f.file.name, mimeType: f.file.type, data: Buffer.from(await f.file.arrayBuffer()) },
        { maxBytes: ACTIVITY_FILE_BYTES },
      );
    else
      await mctx.files.storeUpload(activityId, area, f.uploadId, { maxBytes: ACTIVITY_FILE_BYTES });
  }
  if (remove.length) {
    const files = await db.file.findMany({ where: { id: { in: remove }, contextId: activityId } });
    for (const area of new Set(files.map((f) => f.area))) {
      await mctx.files.remove(
        activityId,
        area,
        files.filter((f) => f.area === area).map((f) => f.id),
      );
    }
  }
}

function activityValues(fd: FormData) {
  const v = formToObject(fd);
  return {
    name: v.name,
    intro: v.intro ?? '',
    showIntro: formBool(fd.get('showIntro')),
    visibility: v.visibility as 'SHOWN',
    completionMode: (v.completionMode || 'NONE') as 'NONE',
    completionRules: collectCompletionRules(fd),
    completionExpectedAt: v.completionExpectedAt || null,
    groupMode: (v.groupMode || 'NONE') as 'NONE',
    groupingId: v.groupingId || null,
    availability: v.availability || null,
    idNumber: v.idNumber,
    settings: collectSettings(fd),
  };
}

export async function createActivityAction(fd: FormData) {
  const v = formToObject(fd);
  const res = await runAction(async () => {
    const ctx = await getContext();
    await checkActivityFiles(fd);
    const r = await createActivity.run(ctx, {
      courseId: v.courseId,
      sectionId: v.sectionId,
      moduleKey: v.moduleKey,
      ...activityValues(fd),
    });
    await saveActivityFiles(r.id, fd);
    return r;
  });
  if (res.ok) redirect(`/course/${v.courseId}?edit=1#a-${res.data.id}`);
  return res;
}

export async function updateActivityAction(fd: FormData) {
  const v = formToObject(fd);
  const res = await runAction(async () => {
    await checkActivityFiles(fd);
    const r = await updateActivity.run(await getContext(), { id: v.id, ...activityValues(fd) });
    await saveActivityFiles(r.id, fd);
    return r;
  });
  if (res.ok && v.returnTo) redirect(safePath(v.returnTo, '/'));
  return res;
}

export async function activityCommandAction(
  courseId: string,
  id: string,
  cmd: 'up' | 'down' | 'show' | 'hide' | 'stealth' | 'duplicate' | 'delete' | 'restore' | 'purge',
) {
  return runAction(async () => {
    const ctx = await getContext();
    switch (cmd) {
      case 'up':
      case 'down':
        await moveActivityStep.run(ctx, { id, direction: cmd });
        break;
      case 'show':
        await setActivityVisibility.run(ctx, { id, visibility: 'SHOWN' });
        break;
      case 'hide':
        await setActivityVisibility.run(ctx, { id, visibility: 'HIDDEN' });
        break;
      case 'stealth':
        await setActivityVisibility.run(ctx, { id, visibility: 'STEALTH' });
        break;
      case 'duplicate': {
        const t = await getTranslations('course');
        await duplicateActivity(ctx, id, (name) => t('copyName', { name }));
        break;
      }
      case 'delete':
        await deleteActivity.run(ctx, { id });
        break;
      case 'restore':
        await restoreActivity.run(ctx, { id });
        break;
      case 'purge':
        await purgeActivity.run(ctx, { id });
        break;
    }
    revalidatePath(`/course/${courseId}`, 'layout');
    return null;
  });
}

export async function moveActivityToSectionAction(courseId: string, id: string, sectionId: string) {
  return runAction(async () => {
    await moveActivity.run(await getContext(), { id, sectionId, beforeId: null });
    revalidatePath(`/course/${courseId}`);
    return null;
  });
}

export async function toggleCompletionAction(courseId: string, activityId: string, done: boolean) {
  return runAction(async () => {
    const r = await toggleManualCompletion.run(await getContext(), { activityId, done });
    revalidatePath(`/course/${courseId}`);
    revalidatePath('/dashboard');
    return r;
  });
}

export async function overrideCompletionAction(
  courseId: string,
  activityId: string,
  userId: string,
  state: 'INCOMPLETE' | 'COMPLETE' | 'CLEAR',
) {
  return runAction(async () => {
    await overrideCompletion.run(await getContext(), { activityId, userId, state });
    revalidatePath(`/course/${courseId}/completion`);
    return null;
  });
}

// ── role switch ───────────────────────────────────────────────────────────────

export async function switchRoleAction(courseId: string, roleId: string | null) {
  const jar = await cookies();
  if (roleId) {
    const ctx = await getContext();
    if (
      !(await ctx.perm.can('course:switchrole', courseId)) ||
      !(await isSwitchableRole(db, courseId, roleId))
    )
      return;
  }
  if (roleId)
    jar.set(VIEW_AS_COOKIE, `${courseId}:${roleId}`, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
  else jar.delete(VIEW_AS_COOKIE);
  revalidatePath(`/course/${courseId}`, 'layout');
}

/** Course → Reset. */
export async function resetCourseAction(courseId: string, fd: FormData) {
  return runAction(async () => {
    const on = (k: string) => fd.get(k) === 'on';
    const start = String(fd.get('startDate') ?? '');
    const r = await resetCourse.run(await getContext(), {
      courseId,
      startDate: start || undefined,
      activityData: fd.getAll('activityData').map(String),
      unenrolRoleIds: fd.getAll('unenrolRoleIds').map(String),
      grades: on('grades'),
      completion: on('completion'),
      groupMembers: on('groupMembers'),
      groups: on('groups'),
      groupings: on('groupings'),
      events: on('events'),
      announcements: on('announcements'),
    });
    revalidatePath(`/course/${courseId}`, 'layout');
    return r;
  });
}
