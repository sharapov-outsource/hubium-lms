import 'server-only';
import { listProfileFields, profileFieldLabel } from '@hubium/core';
import type { ProfileFieldView } from '@/components/profile-field-inputs';
import { db } from './db';

/** Custom profile fields for a form; on the person's own profile locked ones are read-only. */
export async function profileFieldViews(
  locale: string,
  opts: { ownProfile?: boolean } = {},
): Promise<ProfileFieldView[]> {
  return (await listProfileFields(db)).map((f) => ({
    shortName: f.shortName,
    label: profileFieldLabel(f, locale),
    type: f.type,
    choices: f.choices,
    required: f.required,
    readOnly: opts.ownProfile && f.locked,
  }));
}

/** Custom profile fields as access-condition choices (`cf:<shortName>`). */
export async function profileConditionFields(locale: string) {
  return (await listProfileFields(db)).map((f) => ({
    key: `cf:${f.shortName}`,
    label: profileFieldLabel(f, locale),
  }));
}
