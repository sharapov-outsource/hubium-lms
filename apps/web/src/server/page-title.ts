import { type Capability, getActivityAccess, getAllSettings, getCourseAccess } from '@hubium/core';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { db } from './db';
import { getContext, getCurrentUser } from './session';

// Browser tab titles. The root layout renders "Page — Site"; a section (a course, the admin
// area, the user's settings) renders "Page · Section — Site" for its pages and "Section — Site"
// for itself. Names of courses, activities and people only appear for viewers who may see them.

const UUID = /^[0-9a-f-]{36}$/;

/** `generateMetadata` for a page titled by one message, e.g. `titled('admin', 'users')`. */
export function titled(namespace: string, key: string) {
  return async (): Promise<Metadata> => ({ title: (await getTranslations(namespace))(key) });
}

/** Title of a layout whose pages show `section` after their own title. */
export async function sectionTitle(section: string): Promise<Metadata> {
  const site = (await getAllSettings(db))['site.name'];
  return { title: { absolute: `${section} — ${site}`, template: `%s · ${section} — ${site}` } };
}

/** Whether the signed-in viewer holds a site capability (titles of admin pages). */
export async function viewerCan(cap: Capability): Promise<boolean> {
  if (!(await getCurrentUser())) return false;
  return (await getContext()).perm.can(cap);
}

/** The course name, for those who can reach the course page. */
export const courseName = cache(async (courseId: string): Promise<string | null> => {
  if (!UUID.test(courseId) || !(await getCurrentUser())) return null;
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId).catch(() => null);
  if (!access || (access.course.deletedAt && !ctx.perm.isSiteAdmin)) return null;
  return access.course.fullName;
});

/**
 * The activity name, for those who can open the activity or have it listed (the same viewers
 * the activity page shows it to); activities hidden from the viewer keep their names to
 * themselves.
 */
export const activityName = cache(
  async (courseId: string, activityId: string): Promise<string | null> => {
    if (!UUID.test(activityId) || !(await courseName(courseId))) return null;
    const ctx = await getContext();
    const r = await getActivityAccess(ctx, activityId).catch(() => null);
    if (!r || r.activity.courseId !== courseId || r.activity.deletedAt) return null;
    return r.canOpen || r.listed || r.access.canManageActivities ? r.activity.name : null;
  },
);
