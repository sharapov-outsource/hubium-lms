import type { Db, Prisma } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { type Localized, localizedText, pickLocalized } from '../lib/localized.ts';
import { defineOperation } from '../operation.ts';
import { renameReportField } from '../reports/custom-fields.ts';
import {
  coerceFieldValue,
  FORM_PREFIX,
  PROFILE_FIELD_TYPES,
  type ProfileFieldType,
  type ProfileValues,
  validateProfileValues,
} from '../users/profile-fields.ts';

// Custom course fields (Moodle's course custom fields): administrators define them, course
// editors fill them in. Values live in Course.customFields as { [shortName]: string | boolean },
// with the types and rules of custom profile fields.

type Tx = Prisma.TransactionClient | Db;

export interface CourseField {
  id: string;
  shortName: string;
  name: Localized;
  type: ProfileFieldType;
  choices: string[];
  required: boolean;
  /** Changed only by people with course:changelockedfields. */
  locked: boolean;
  /** Shown in the catalog and on the course description. */
  visible: boolean;
}

export type CourseFieldValues = ProfileValues;

export async function listCourseFields(db: Tx): Promise<CourseField[]> {
  const rows = await db.courseField.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    shortName: r.shortName,
    name: r.name as Localized,
    type: (PROFILE_FIELD_TYPES as readonly string[]).includes(r.type)
      ? (r.type as ProfileFieldType)
      : 'text',
    choices: ((r.options ?? {}) as { choices?: string[] }).choices ?? [],
    required: r.required,
    locked: r.locked,
    visible: r.visible,
  }));
}

export function courseFieldLabel(f: Pick<CourseField, 'name' | 'shortName'>, locale: string) {
  return pickLocalized(f.name, locale) || f.shortName;
}

/** Filled values in field order; only the visible fields unless `all`. */
export function shownCourseValues(
  fields: CourseField[],
  values: unknown,
  opts: { all?: boolean } = {},
): { field: CourseField; value: string | boolean }[] {
  const v = (values ?? {}) as CourseFieldValues;
  return fields.flatMap((field) => {
    const value = v[field.shortName];
    if ((!opts.all && !field.visible) || value === undefined || value === '' || value === false)
      return [];
    return [{ field, value }];
  });
}

/** The values as an API returns them: visible ones, or all of them for course editors. */
export async function courseValuesFor(
  ctx: RequestContext,
  course: { id: string; customFields: unknown },
  fields?: CourseField[],
): Promise<CourseFieldValues> {
  const list = fields ?? (await listCourseFields(ctx.db));
  const all = await ctx.perm.can('course:update', course.id).catch(() => false);
  return Object.fromEntries(
    shownCourseValues(list, course.customFields, { all }).map((x) => [x.field.shortName, x.value]),
  );
}

/**
 * Checks values submitted for a course (only the fields given are touched) and merges them
 * into the current ones. Required fields must be filled; a locked field changes only for
 * people with course:changelockedfields in the course (its category while it is created).
 */
export async function checkCourseValues(
  ctx: RequestContext,
  tx: Tx,
  raw: Record<string, unknown>,
  current: unknown,
  contextId: string,
): Promise<CourseFieldValues> {
  const fields = (await listCourseFields(tx)).filter((f) => f.shortName in raw);
  const values = validateProfileValues(fields, raw, { requireAll: true });
  const before = (current ?? {}) as CourseFieldValues;
  const locked = fields.filter(
    (f) =>
      f.locked &&
      f.shortName in values &&
      (values[f.shortName] ?? '') !== (before[f.shortName] ?? (f.type === 'checkbox' ? false : '')),
  );
  if (locked.length && !(await ctx.perm.can('course:changelockedfields', contextId)))
    throw new ValidationError(
      Object.fromEntries(locked.map((f) => [FORM_PREFIX + f.shortName, ['This field is locked']])),
    );
  return { ...before, ...values };
}

/**
 * Values from another site (a backup or a Moodle course) for the fields this site has with
 * the same short names; values that do not fit are left out.
 */
export function foreignCourseValues(
  fields: CourseField[],
  raw: Record<string, unknown>,
): CourseFieldValues {
  const out: CourseFieldValues = {};
  for (const f of fields) {
    if (!(f.shortName in raw)) continue;
    const r = coerceFieldValue(f, raw[f.shortName]);
    if (!r.error && r.value !== undefined) out[f.shortName] = r.value;
  }
  return out;
}

// ── administration ──────────────────────────────────────────────────────────

export const CourseFieldInput = z
  .object({
    id: z.string().uuid().optional(),
    shortName: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9_]{1,49}$/, 'Latin letters, digits and _; starts with a letter'),
    name: localizedText(100),
    type: z.enum(PROFILE_FIELD_TYPES),
    choices: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    required: z.boolean().default(false),
    locked: z.boolean().default(false),
    visible: z.boolean().default(true),
  })
  .refine((v) => v.type !== 'menu' || v.choices.length > 0, {
    message: 'A menu needs at least one option',
    path: ['choices'],
  });

export const saveCourseField = defineOperation({
  name: 'courseField.save',
  input: CourseFieldInput,
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, input) {
    const taken = await ctx.tx.courseField.findUnique({
      where: { shortName: input.shortName },
      select: { id: true },
    });
    if (taken && taken.id !== input.id)
      throw new ValidationError({ shortName: [msg('errors.courses.fieldShortNameInUse')] });
    const data = {
      shortName: input.shortName,
      name: input.name,
      type: input.type,
      options: { choices: input.type === 'menu' ? input.choices : [] },
      required: input.required,
      locked: input.locked,
      visible: input.visible,
    };
    let id = input.id;
    if (id) {
      const prev = await ctx.tx.courseField.findUnique({ where: { id } });
      if (!prev) throw new NotFoundError('Course field');
      // Values and reports name the field by its short name: renaming carries them over.
      if (prev.shortName !== input.shortName) {
        await ctx.tx.$executeRaw`
          UPDATE "Course" SET "customFields" = ("customFields" - ${prev.shortName}::text)
            || jsonb_build_object(${input.shortName}::text, "customFields" -> ${prev.shortName}::text)
          WHERE "customFields" ? ${prev.shortName}::text`;
        await renameReportField(ctx.tx, 'course', prev.shortName, input.shortName);
      }
      await ctx.tx.courseField.update({ where: { id }, data });
    } else {
      const last = await ctx.tx.courseField.aggregate({ _max: { sortOrder: true } });
      id = (
        await ctx.tx.courseField.create({
          data: { ...data, sortOrder: (last._max.sortOrder ?? 0) + 1 },
        })
      ).id;
    }
    await logEvent(ctx.tx, {
      name: input.id ? 'coursefield.updated' : 'coursefield.created',
      actorId: ctx.perm.userId,
      objectType: 'coursefield',
      objectId: id,
      data: { shortName: input.shortName },
      origin: ctx.origin,
    });
    return { id };
  },
});

export const deleteCourseField = defineOperation({
  name: 'courseField.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, { id }) {
    const f = await ctx.tx.courseField.findUnique({ where: { id } });
    if (!f) throw new NotFoundError('Course field');
    await ctx.tx.courseField.delete({ where: { id } });
    await ctx.tx.$executeRaw`
      UPDATE "Course" SET "customFields" = "customFields" - ${f.shortName}::text
      WHERE "customFields" ? ${f.shortName}::text`;
    await logEvent(ctx.tx, {
      name: 'coursefield.deleted',
      actorId: ctx.perm.userId,
      objectType: 'coursefield',
      objectId: id,
      data: { shortName: f.shortName },
      origin: ctx.origin,
    });
    return { ok: true };
  },
});

export const moveCourseField = defineOperation({
  name: 'courseField.move',
  input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, { id, direction }) {
    const all = await ctx.tx.courseField.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    const i = all.findIndex((f) => f.id === id);
    if (i < 0) throw new NotFoundError('Course field');
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= all.length) return { ok: true };
    [all[i], all[j]] = [all[j]!, all[i]!];
    for (const [n, f] of all.entries())
      await ctx.tx.courseField.update({ where: { id: f.id }, data: { sortOrder: n + 1 } });
    return { ok: true };
  },
});

/**
 * Catalog filters by visible menu and checkbox fields: `{ shortName: choice | 'yes' | 'no' }`.
 * Unknown fields and choices are ignored.
 */
export async function courseFieldFilters(
  db: Tx,
  filters: Record<string, string>,
): Promise<Prisma.CourseWhereInput[]> {
  const fields = (await listCourseFields(db)).filter((f) => f.visible);
  const out: Prisma.CourseWhereInput[] = [];
  for (const [key, value] of Object.entries(filters)) {
    const f = fields.find((x) => x.shortName === key);
    if (!f || !value) continue;
    if (f.type === 'menu' && f.choices.includes(value))
      out.push({ customFields: { path: [key], equals: value } });
    else if (f.type === 'checkbox' && value === 'yes')
      out.push({ customFields: { path: [key], equals: true } });
    else if (f.type === 'checkbox' && value === 'no')
      out.push({ NOT: { customFields: { path: [key], equals: true } } });
  }
  return out;
}
