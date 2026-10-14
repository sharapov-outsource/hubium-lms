import 'server-only';
import {
  type CourseField,
  courseFieldLabel,
  listCourseFields,
  type RequestContext,
  shownCourseValues,
} from '@hubium/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ProfileFieldView } from '@/components/profile-field-inputs';
import { db } from './db';

/**
 * Custom course fields for the course form; locked ones are read-only for people who may
 * not change them (in the course, or in its category while it is created).
 */
export async function courseFieldViews(
  ctx: RequestContext,
  locale: string,
  contextId: string,
): Promise<ProfileFieldView[]> {
  const fields = await listCourseFields(db);
  const locked =
    fields.some((f) => f.locked) &&
    !(await ctx.perm.can('course:changelockedfields', contextId).catch(() => false));
  return fields.map((f) => ({
    shortName: f.shortName,
    label: courseFieldLabel(f, locale),
    type: f.type,
    choices: f.choices,
    required: f.required,
    readOnly: f.locked && locked,
  }));
}

/** Filled visible values as label and text (dates and checkboxes in words). */
export async function courseFieldDisplay(
  values: unknown,
  locale: string,
  fields?: CourseField[],
): Promise<{ key: string; label: string; text: string }[]> {
  const [tc, format] = await Promise.all([getTranslations('common'), getFormatter()]);
  return shownCourseValues(fields ?? (await listCourseFields(db)), values).map(
    ({ field, value }) => ({
      key: field.shortName,
      label: courseFieldLabel(field, locale),
      text:
        value === true
          ? tc('yes')
          : field.type === 'date' && typeof value === 'string'
            ? format.dateTime(new Date(`${value}T00:00:00Z`), {
                dateStyle: 'long',
                timeZone: 'UTC',
              })
            : String(value),
    }),
  );
}
