import type { Db, Prisma } from '@hubium/db';
import { locales } from '@hubium/i18n';
import { createTranslator } from '@hubium/i18n/packs';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { type Localized, localizedText, pickLocalized } from '../lib/localized.ts';
import { defineOperation } from '../operation.ts';

// Custom profile fields defined by administrators. Values live in User.customFields as
// { [shortName]: string | boolean }: text, a date (YYYY-MM-DD), a menu choice or a checkbox.

type Tx = Prisma.TransactionClient | Db;

export const PROFILE_FIELD_TYPES = ['text', 'textarea', 'checkbox', 'menu', 'date'] as const;
export type ProfileFieldType = (typeof PROFILE_FIELD_TYPES)[number];

export interface ProfileField {
  id: string;
  shortName: string;
  /** The field's label by language. */
  name: Localized;
  type: ProfileFieldType;
  choices: string[];
  required: boolean;
  locked: boolean;
  visibleToOthers: boolean;
}

export type ProfileValues = Record<string, string | boolean>;

/** What validating a value needs; course fields share the same types and rules. */
export type FieldSpec = Pick<ProfileField, 'shortName' | 'type' | 'choices' | 'required'>;

/** Prefix of profile field inputs in forms and of CSV upload columns. */
export const FORM_PREFIX = 'cf_';
export const CSV_PREFIX = 'profile_field_';

export async function listProfileFields(db: Tx): Promise<ProfileField[]> {
  const rows = await db.userProfileField.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    shortName: r.shortName,
    name: r.name as ProfileField['name'],
    type: (PROFILE_FIELD_TYPES as readonly string[]).includes(r.type)
      ? (r.type as ProfileFieldType)
      : 'text',
    choices: ((r.options ?? {}) as { choices?: string[] }).choices ?? [],
    required: r.required,
    locked: r.locked,
    visibleToOthers: r.visibleToOthers,
  }));
}

export function profileFieldLabel(f: Pick<ProfileField, 'name' | 'shortName'>, locale: string) {
  return pickLocalized(f.name, locale) || f.shortName;
}

/** "Yes" and "no" in every installed language (CSV files are typed by people). */
function words(key: 'common.yes' | 'common.no', base: string[]): Set<string> {
  return new Set([...base, ...locales.map((l) => createTranslator(l)(key).toLowerCase())]);
}
let yesNo: { yes: Set<string>; no: Set<string> } | undefined;
const yesNoWords = () =>
  (yesNo ??= {
    yes: words('common.yes', ['1', 'true', 'yes', 'on']),
    no: words('common.no', ['', '0', 'false', 'no', 'off']),
  });

/** One raw value (form, CSV, API) to its stored form, or an error message. */
export function coerceFieldValue(
  f: FieldSpec,
  raw: unknown,
): { value?: string | boolean; error?: string } {
  if (f.type === 'checkbox') {
    if (typeof raw === 'boolean') return { value: raw };
    const s = String(raw ?? '')
      .trim()
      .toLowerCase();
    if (yesNoWords().yes.has(s)) return { value: true };
    if (yesNoWords().no.has(s)) return { value: false };
    return { error: 'Expected yes or no' };
  }
  const s = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
  if (!s) return { value: '' };
  if (f.type === 'text' && s.length > 255) return { error: 'At most 255 characters' };
  if (f.type === 'textarea' && s.length > 5000) return { error: 'At most 5000 characters' };
  if (f.type === 'menu' && !f.choices.includes(s)) return { error: 'Choose one of the options' };
  if (f.type === 'date') {
    const d = new Date(`${s}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()))
      return { error: 'Expected a date (YYYY-MM-DD)' };
  }
  return { value: s };
}

/**
 * Validates submitted values for `fields` (others are ignored). Field errors are keyed
 * `cf_<shortName>`, like the form inputs. With `requireAll`, required fields must be filled.
 */
export function validateProfileValues(
  fields: FieldSpec[],
  raw: Record<string, unknown>,
  opts: { requireAll?: boolean } = {},
): ProfileValues {
  const out: ProfileValues = {};
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (!(f.shortName in raw)) {
      if (opts.requireAll && f.required && f.type !== 'checkbox')
        errors[FORM_PREFIX + f.shortName] = ['Required'];
      continue;
    }
    const r = coerceFieldValue(f, raw[f.shortName]);
    if (r.error) errors[FORM_PREFIX + f.shortName] = [r.error];
    else if (opts.requireAll && f.required && r.value === '')
      errors[FORM_PREFIX + f.shortName] = ['Required'];
    else out[f.shortName] = r.value!;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

/** Values of `cf_*` inputs in a submitted form, for `fields` (unchecked boxes are false). */
export function profileValuesFromForm(
  fields: FieldSpec[],
  form: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields)
    out[f.shortName] =
      f.type === 'checkbox' ? FORM_PREFIX + f.shortName in form : form[FORM_PREFIX + f.shortName];
  return out;
}

/** Stored values as text, for conditions and exports (checkboxes become 1 / 0). */
export function profileValueText(v: string | boolean | undefined): string {
  return typeof v === 'boolean' ? (v ? '1' : '0') : (v ?? '');
}

/** Merges validated values into the user's stored custom fields. */
export async function writeProfileValues(db: Tx, userId: string, values: ProfileValues) {
  if (!Object.keys(values).length) return;
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { customFields: true },
  });
  await db.user.update({
    where: { id: userId },
    data: {
      customFields: { ...((user.customFields ?? {}) as ProfileValues), ...values },
    },
  });
}

// ── administration ──────────────────────────────────────────────────────────

const LocalisedName = localizedText(100);

export const ProfileFieldInput = z
  .object({
    id: z.string().uuid().optional(),
    shortName: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9_]{1,49}$/, 'Latin letters, digits and _; starts with a letter'),
    name: LocalisedName,
    type: z.enum(PROFILE_FIELD_TYPES),
    choices: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    required: z.boolean().default(false),
    locked: z.boolean().default(false),
    visibleToOthers: z.boolean().default(false),
  })
  .refine((v) => v.type !== 'menu' || v.choices.length > 0, {
    message: 'A menu needs at least one option',
    path: ['choices'],
  });

export const saveProfileField = defineOperation({
  name: 'profileField.save',
  input: ProfileFieldInput,
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, input) {
    const taken = await ctx.tx.userProfileField.findUnique({
      where: { shortName: input.shortName },
      select: { id: true },
    });
    if (taken && taken.id !== input.id)
      throw new ValidationError({ shortName: ['This short name is already in use'] });
    const data = {
      shortName: input.shortName,
      name: input.name,
      type: input.type,
      options: { choices: input.type === 'menu' ? input.choices : [] },
      required: input.required,
      locked: input.locked,
      visibleToOthers: input.visibleToOthers,
    };
    let id = input.id;
    if (id) {
      const prev = await ctx.tx.userProfileField.findUnique({ where: { id } });
      if (!prev) throw new NotFoundError('Profile field');
      // Values are stored under the short name: renaming carries them over.
      if (prev.shortName !== input.shortName)
        await ctx.tx.$executeRaw`
          UPDATE "User" SET "customFields" = ("customFields" - ${prev.shortName}::text)
            || jsonb_build_object(${input.shortName}::text, "customFields" -> ${prev.shortName}::text)
          WHERE "customFields" ? ${prev.shortName}::text`;
      await ctx.tx.userProfileField.update({ where: { id }, data });
    } else {
      const last = await ctx.tx.userProfileField.aggregate({ _max: { sortOrder: true } });
      id = (
        await ctx.tx.userProfileField.create({
          data: { ...data, sortOrder: (last._max.sortOrder ?? 0) + 1 },
        })
      ).id;
    }
    await logEvent(ctx.tx, {
      name: input.id ? 'profilefield.updated' : 'profilefield.created',
      actorId: ctx.perm.userId,
      objectType: 'profilefield',
      objectId: id,
      data: { shortName: input.shortName },
      origin: ctx.origin,
    });
    return { id };
  },
});

export const deleteProfileField = defineOperation({
  name: 'profileField.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, { id }) {
    const f = await ctx.tx.userProfileField.findUnique({ where: { id } });
    if (!f) throw new NotFoundError('Profile field');
    await ctx.tx.userProfileField.delete({ where: { id } });
    await ctx.tx.$executeRaw`
      UPDATE "User" SET "customFields" = "customFields" - ${f.shortName}::text
      WHERE "customFields" ? ${f.shortName}::text`;
    await logEvent(ctx.tx, {
      name: 'profilefield.deleted',
      actorId: ctx.perm.userId,
      objectType: 'profilefield',
      objectId: id,
      data: { shortName: f.shortName },
      origin: ctx.origin,
    });
    return { ok: true };
  },
});

export const moveProfileField = defineOperation({
  name: 'profileField.move',
  input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, { id, direction }) {
    const all = await ctx.tx.userProfileField.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    const i = all.findIndex((f) => f.id === id);
    if (i < 0) throw new NotFoundError('Profile field');
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= all.length) return { ok: true };
    [all[i], all[j]] = [all[j]!, all[i]!];
    for (const [n, f] of all.entries())
      await ctx.tx.userProfileField.update({ where: { id: f.id }, data: { sortOrder: n + 1 } });
    return { ok: true };
  },
});
