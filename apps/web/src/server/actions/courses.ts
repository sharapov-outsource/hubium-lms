'use server';

import {
  addCohortSync,
  addSection,
  autoCreateGroups,
  buildModuleCtx,
  createActivity,
  createCategory,
  createCohort,
  createCourse,
  createGroup,
  createGrouping,
  deleteActivity,
  deleteCategory,
  deleteCohort,
  deleteCourse,
  deleteGroup,
  deleteGrouping,
  deleteSection,
  duplicateActivity,
  enrolUsers,
  importCohorts,
  importCourseGroups,
  isSwitchableRole,
  moveActivity,
  moveActivityStep,
  moveCategoryOrder,
  moveSection,
  moveSubsection,
  overrideCompletion,
  profileValuesFromForm,
  purgeActivity,
  removeEnrolmentMethod,
  resetCourse,
  resolveLogins,
  restoreActivity,
  restoreCourse,
  searchEnrollableUsers,
  selfEnrol,
  setActivityVisibility,
  setCohortMembers,
  setCourseImage,
  setCourseRoles,
  setEnrolmentStatus,
  setGroupingGroups,
  setGroupMembers,
  setSectionVisible,
  toggleManualCompletion,
  unenrolSelf,
  unenrolUser,
  updateActivity,
  updateCategory,
  updateCourse,
  updateGroup,
  updateGrouping,
  updateSection,
  updateSelfEnrolment,
  ValidationError,
} from '@hubium/core';
import { storeFile } from '@hubium/core/files/files';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { safePath } from '@/lib/safe-path';
import { formToObject, runAction } from '../action';
import { courseFieldViews } from '../course-fields';
import { db } from '../db';
import { getContext, VIEW_AS_COOKIE } from '../session';

const bool = (v: FormDataEntryValue | null) => v === 'on' || v === 'true' || v === '1';

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
    visible: bool(fd.get('visible')),
    lang: v.lang || null,
    enableCompletion: bool(fd.get('enableCompletion')),
    groupMode: v.groupMode,
    groupModeForced: bool(fd.get('groupModeForced')),
    guestAccess: bool(fd.get('guestAccess')),
  };
}

async function saveCourseImage(courseId: string, fd: FormData) {
  const image = fd.get('image');
  if (!(image instanceof File) || image.size === 0) return;
  const ctx = await getContext();
  const f = await storeFile(db, {
    contextId: courseId,
    component: 'course',
    area: 'image',
    name: image.name,
    mimeType: image.type,
    data: Buffer.from(await image.arrayBuffer()),
    uploadedById: ctx.perm.userId,
    maxBytes: 5 * 1024 * 1024,
    allowedTypes: /^image\/(png|jpeg|webp|gif)$/,
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
    const r = await createCourse.run(await getContext(), {
      ...values,
      customFields: await customFieldValues(fd, values.categoryId ?? ''),
    });
    await saveCourseImage(r.id, fd);
    return r;
  });
  if (res.ok) redirect(`/course/${res.data.id}?edit=1`);
  return res;
}

export async function updateCourseAction(fd: FormData) {
  return runAction(async () => {
    const id = String(fd.get('id'));
    const r = await updateCourse.run(await getContext(), {
      id,
      ...courseFormValues(fd),
      customFields: await customFieldValues(fd, id),
    });
    await saveCourseImage(id, fd);
    if (bool(fd.get('removeImage'))) await setCourseImage(await getContext(), id, null);
    revalidatePath(`/course/${id}`, 'layout');
    return r;
  });
}

export async function deleteCourseAction(id: string) {
  const res = await runAction(async () => deleteCourse.run(await getContext(), { id }));
  if (res.ok) redirect('/my-courses');
  return res;
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
  return { view: bool(fd.get('completionView')), module };
}

async function saveActivityFiles(activityId: string, fd: FormData) {
  const ctx = await getContext();
  const mctx = buildModuleCtx(ctx);
  const remove = fd.getAll('files.remove').map(String);
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith('files.') || k === 'files.remove' || !(v instanceof File) || v.size === 0)
      continue;
    const area = k.slice('files.'.length);
    await mctx.files.store(
      activityId,
      area,
      { name: v.name, mimeType: v.type, data: Buffer.from(await v.arrayBuffer()) },
      { maxBytes: 200 * 1024 * 1024 },
    );
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
    showIntro: bool(fd.get('showIntro')),
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
      case 'duplicate':
        await duplicateActivity.run(ctx, { id });
        break;
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

// ── enrolment ─────────────────────────────────────────────────────────────────

export async function searchUsersToEnrolAction(courseId: string, q: string) {
  return runAction(async () => searchEnrollableUsers(await getContext(), courseId, q));
}

export async function enrolUsersAction(
  courseId: string,
  userIds: string[],
  roleId: string,
  endsAt?: string,
) {
  return runAction(async () => {
    const r = await enrolUsers.run(await getContext(), { courseId, userIds, roleId, endsAt });
    revalidatePath(`/course/${courseId}/participants`);
    return r;
  });
}

export async function participantCommandAction(
  courseId: string,
  userId: string,
  cmd: 'unenrol' | 'suspend' | 'activate',
) {
  return runAction(async () => {
    const ctx = await getContext();
    if (cmd === 'unenrol') await unenrolUser.run(ctx, { courseId, userId });
    else
      await setEnrolmentStatus.run(ctx, {
        courseId,
        userId,
        status: cmd === 'suspend' ? 'SUSPENDED' : 'ACTIVE',
      });
    revalidatePath(`/course/${courseId}/participants`);
    return null;
  });
}

export async function setRolesAction(courseId: string, userId: string, roleIds: string[]) {
  return runAction(async () => {
    await setCourseRoles.run(await getContext(), { courseId, userId, roleIds });
    revalidatePath(`/course/${courseId}/participants`);
    return null;
  });
}

export async function saveSelfEnrolmentAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await updateSelfEnrolment.run(await getContext(), {
      courseId: v.courseId,
      enabled: bool(fd.get('enabled')),
      key: v.key,
      useGroupKeys: bool(fd.get('useGroupKeys')),
      startsAt: v.startsAt,
      endsAt: v.endsAt,
      durationDays: v.durationDays,
      maxEnrolled: v.maxEnrolled,
      welcome: v.welcome ?? '',
    });
    revalidatePath(`/course/${v.courseId}/enrolment`);
    return r;
  });
}

export async function addCohortSyncAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await addCohortSync.run(await getContext(), {
      courseId: v.courseId,
      cohortId: v.cohortId,
      roleId: v.roleId,
    });
    revalidatePath(`/course/${v.courseId}/enrolment`);
    return r;
  });
}

export async function removeMethodAction(courseId: string, methodId: string) {
  return runAction(async () => {
    await removeEnrolmentMethod.run(await getContext(), { methodId });
    revalidatePath(`/course/${courseId}/enrolment`);
    return null;
  });
}

export async function selfEnrolAction(fd: FormData) {
  const v = formToObject(fd);
  const res = await runAction(async () =>
    selfEnrol.run(await getContext(), { courseId: v.courseId, key: v.key }),
  );
  if (res.ok) {
    revalidatePath('/', 'layout');
    redirect(`/course/${v.courseId}`);
  }
  return res;
}

export async function leaveCourseAction(courseId: string) {
  const res = await runAction(async () => unenrolSelf.run(await getContext(), { courseId }));
  if (res.ok) redirect('/my-courses');
  return res;
}

// ── groups ────────────────────────────────────────────────────────────────────

export async function saveGroupAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    const input = {
      name: v.name,
      description: v.description ?? '',
      enrolmentKey: v.enrolmentKey,
      idNumber: v.idNumber,
    };
    const r = v.id
      ? await updateGroup.run(ctx, { id: v.id, ...input })
      : await createGroup.run(ctx, { courseId: v.courseId, ...input });
    revalidatePath(`/course/${v.courseId}/groups`);
    return r;
  });
}

export async function deleteGroupAction(courseId: string, id: string) {
  return runAction(async () => {
    await deleteGroup.run(await getContext(), { id });
    revalidatePath(`/course/${courseId}/groups`);
    return null;
  });
}

export async function groupMembersAction(
  courseId: string,
  groupId: string,
  add: string[],
  remove: string[],
) {
  return runAction(async () => {
    await setGroupMembers.run(await getContext(), { groupId, add, remove });
    revalidatePath(`/course/${courseId}/groups`);
    return null;
  });
}

export async function saveGroupingAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    const input = { name: v.name, description: v.description ?? '' };
    const r = v.id
      ? await updateGrouping.run(ctx, { id: v.id, ...input })
      : await createGrouping.run(ctx, { courseId: v.courseId, ...input });
    revalidatePath(`/course/${v.courseId}/groups`);
    return r;
  });
}

export async function deleteGroupingAction(courseId: string, id: string) {
  return runAction(async () => {
    await deleteGrouping.run(await getContext(), { id });
    revalidatePath(`/course/${courseId}/groups`);
    return null;
  });
}

export async function groupingGroupsAction(
  courseId: string,
  groupingId: string,
  groupIds: string[],
) {
  return runAction(async () => {
    await setGroupingGroups.run(await getContext(), { groupingId, groupIds });
    revalidatePath(`/course/${courseId}/groups`);
    return null;
  });
}

// ── categories & cohorts (admin) ──────────────────────────────────────────────

export async function saveCategoryAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    const input = {
      name: v.name,
      description: v.description ?? '',
      idNumber: v.idNumber,
      parentId: v.parentId || null,
      visible: bool(fd.get('visible')),
    };
    const r = v.id
      ? await updateCategory.run(ctx, { id: v.id, ...input })
      : await createCategory.run(ctx, input);
    revalidatePath('/admin/categories');
    return r;
  });
}

export async function categoryCommandAction(id: string, cmd: 'up' | 'down' | 'delete') {
  return runAction(async () => {
    const ctx = await getContext();
    if (cmd === 'delete') await deleteCategory.run(ctx, { id });
    else await moveCategoryOrder.run(ctx, { id, direction: cmd });
    revalidatePath('/admin/categories');
    return null;
  });
}

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
    revalidatePath('/admin/cohorts');
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
    if (!add.length) throw new ValidationError({ login: ['User not found'] });
    await setCohortMembers.run(ctx, { cohortId: v.cohortId, add, remove: [] });
    revalidatePath('/admin/cohorts');
    return null;
  });
}

export async function deleteCohortAction(id: string) {
  return runAction(async () => {
    await deleteCohort.run(await getContext(), { id });
    revalidatePath('/admin/cohorts');
    return null;
  });
}

/** Course groups from a CSV file; `apply` false only checks it. */
export async function importGroupsAction(courseId: string, csv: string, apply: boolean) {
  return runAction(async () => {
    const r = await importCourseGroups.run(await getContext(), { courseId, csv, apply });
    if (apply) revalidatePath(`/course/${courseId}/groups`);
    return r;
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

export async function autoGroupsAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await autoCreateGroups.run(await getContext(), {
      courseId: v.courseId ?? '',
      roleId: v.roleId ?? '',
      by: v.by === 'size' ? 'size' : 'count',
      number: Number(v.number),
      pattern: v.pattern ?? '',
      order: v.order === 'name' ? 'name' : 'random',
      grouping: v.grouping ?? '',
    });
    revalidatePath(`/course/${v.courseId}/groups`);
    return r;
  });
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
