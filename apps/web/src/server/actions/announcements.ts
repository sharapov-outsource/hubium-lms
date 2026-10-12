'use server';

import {
  createAnnouncement,
  deleteAnnouncement,
  pinAnnouncement,
  updateAnnouncement,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { runAction } from '../action';
import { getContext } from '../session';

function fields(fd: FormData) {
  return {
    title: String(fd.get('title') ?? ''),
    contentHtml: String(fd.get('contentHtml') ?? ''),
    pinned: fd.get('pinned') === 'on',
    notify: fd.get('notify') === 'on',
    publishAt: (fd.get('publishAt') as string) || null,
    groupId: (fd.get('groupId') as string) || null,
  };
}

const paths = (courseId: string | null) => {
  if (courseId) revalidatePath(`/course/${courseId}/stream`);
  else revalidatePath('/admin/announcements');
  revalidatePath('/dashboard');
};

export async function saveAnnouncementAction(fd: FormData) {
  return runAction(async () => {
    const id = fd.get('id') as string | null;
    const courseId = (fd.get('courseId') as string) || null;
    const ctx = await getContext();
    const r = id
      ? await updateAnnouncement.run(ctx, { id, ...fields(fd) })
      : await createAnnouncement.run(ctx, { courseId, ...fields(fd) });
    paths(courseId);
    return r;
  });
}

export async function deleteAnnouncementAction(id: string, courseId: string | null) {
  return runAction(async () => {
    await deleteAnnouncement.run(await getContext(), { id });
    paths(courseId);
    return null;
  });
}

export async function pinAnnouncementAction(id: string, pinned: boolean, courseId: string | null) {
  return runAction(async () => {
    await pinAnnouncement.run(await getContext(), { id, pinned });
    paths(courseId);
    return null;
  });
}
