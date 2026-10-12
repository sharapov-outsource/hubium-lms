import { type Db, Prisma } from '@hubium/db';
import { z } from 'zod';
import { ValidationError } from '../errors.ts';

// Typed site settings. Each setting is declared once with a zod schema and a default;
// values are stored in SiteSetting(key, value Json) and cached in memory.

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb colour');

export const settingDefs = {
  'site.name': z.string().min(1).max(100).default('Hubium'),
  'site.defaultLocale': z.enum(['ru', 'en']).default('ru'),
  'site.defaultTimezone': z.string().default('Europe/Moscow'),
  'branding.accent': hex.default('#4f46e5'),
  'branding.logoFileId': z.string().uuid().nullable().default(null),
  'registration.enabled': z.boolean().default(false),
  'registration.requireEmailVerification': z.boolean().default(true),
  'registration.consentText': z.string().default(''),
  'auth.oauth.google': z.boolean().default(false),
  'auth.oauth.yandex': z.boolean().default(false),
  'auth.oauth.vk': z.boolean().default(false),
  'auth.require2faForAdmins': z.boolean().default(false),
  'email.fromName': z.string().default('Hubium'),
  'course.creatorRole': z.string().default('editingteacher'),
  'mentors.enabled': z.boolean().default(false),
} as const satisfies Record<string, z.ZodType>;

export type SettingKey = keyof typeof settingDefs;
export type SettingValue<K extends SettingKey> = z.output<(typeof settingDefs)[K]>;
export type AllSettings = { [K in SettingKey]: SettingValue<K> };

let cache: AllSettings | undefined;

export function invalidateSettingsCache(): void {
  cache = undefined;
}

export function defaultSettings(): AllSettings {
  const out: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(settingDefs)) out[k] = schema.parse(undefined);
  return out as AllSettings;
}

export async function getAllSettings(db: Db): Promise<AllSettings> {
  if (cache) return cache;
  const rows = await db.siteSetting.findMany({
    where: { key: { in: Object.keys(settingDefs) } },
  });
  const out = defaultSettings() as Record<string, unknown>;
  for (const row of rows) {
    const schema = settingDefs[row.key as SettingKey];
    const parsed = schema.safeParse(row.value);
    if (parsed.success) out[row.key] = parsed.data;
  }
  cache = out as AllSettings;
  return cache;
}

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingValue<K>> {
  return (await getAllSettings(db))[key];
}

export async function setSettings(
  db: Db | Prisma.TransactionClient,
  values: Partial<{ [K in SettingKey]: unknown }>,
  updatedById?: string,
): Promise<void> {
  const fieldErrors: Record<string, string[]> = {};
  const parsed: [string, unknown][] = [];
  for (const [key, value] of Object.entries(values)) {
    const schema = settingDefs[key as SettingKey];
    if (!schema) {
      fieldErrors[key] = ['Unknown setting'];
      continue;
    }
    const r = schema.safeParse(value);
    if (r.success) parsed.push([key, r.data]);
    else fieldErrors[key] = r.error.issues.map((i) => i.message);
  }
  if (Object.keys(fieldErrors).length) throw new ValidationError(fieldErrors);
  for (const [key, value] of parsed) {
    const json =
      value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
    await db.siteSetting.upsert({
      where: { key },
      create: { key, value: json, updatedById },
      update: { value: json, updatedById },
    });
  }
  invalidateSettingsCache();
}
