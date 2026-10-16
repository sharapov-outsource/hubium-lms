'use server';

import {
  addCohortSync,
  assignActivityRole,
  enrolUsers,
  listParticipants,
  removeEnrolmentMethod,
  searchEnrollableUsers,
  selfEnrol,
  setCourseRoles,
  setEnrolmentStatus,
  unenrolSelf,
  unenrolUser,
  updateSelfEnrolment,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { formBool, formToObject, runAction } from '../action';
import { getContext } from '../session';

// Course → Participants: enrolment, roles and enrolment methods.

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
      enabled: formBool(fd.get('enabled')),
      key: v.key,
      useGroupKeys: formBool(fd.get('useGroupKeys')),
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

/** Course participants found by name, for giving one a role in an activity. */
export async function searchCourseMembersAction(courseId: string, q: string) {
  return runAction(async () => {
    if (q.trim().length < 2) return [];
    const r = await listParticipants(await getContext(), { courseId, q, pageSize: 10 });
    return r.users.map((u) => ({ id: u.id, name: u.name, email: u.email || null }));
  });
}

/** Gives or takes a role in one activity of the course. */
export async function assignActivityRoleAction(
  courseId: string,
  activityId: string,
  userId: string,
  roleId: string,
  assigned: boolean,
) {
  return runAction(async () => {
    const r = await assignActivityRole.run(await getContext(), {
      activityId,
      userId,
      roleId,
      assigned,
    });
    revalidatePath(`/course/${courseId}/a/${activityId}/permissions`);
    return r;
  });
}
