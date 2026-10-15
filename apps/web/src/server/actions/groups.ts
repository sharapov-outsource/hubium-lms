'use server';

import {
  autoCreateGroups,
  createGroup,
  createGrouping,
  deleteGroup,
  deleteGrouping,
  importCourseGroups,
  setGroupingGroups,
  setGroupMembers,
  updateGroup,
  updateGrouping,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

// Course → Groups: groups, groupings and their import.

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

/** Course groups from a CSV file; `apply` false only checks it. */
export async function importGroupsAction(courseId: string, csv: string, apply: boolean) {
  return runAction(async () => {
    const r = await importCourseGroups.run(await getContext(), { courseId, csv, apply });
    if (apply) revalidatePath(`/course/${courseId}/groups`);
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
