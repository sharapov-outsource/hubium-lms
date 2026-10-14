import { type Db, Prisma } from '@hubium/db';
import { BASE_LOCALE, DEFAULT_SITE_LOCALE, isLocale, type Locale, locales } from '@hubium/i18n';
import { z } from 'zod';
import { ValidationError } from '../errors.ts';

// Typed site settings. Each setting is declared once with a zod schema and a default;
// values are stored in SiteSetting(key, value Json) and cached in memory.

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb colour');

export const settingDefs = {
  'site.name': z.string().min(1).max(100).default('Hubium LMS'),
  'site.defaultLocale': z
    .string()
    .refine(isLocale, 'Unknown language')
    .default(isLocale(DEFAULT_SITE_LOCALE) ? DEFAULT_SITE_LOCALE : BASE_LOCALE),
  /** Installed languages users may not choose; new languages are enabled by default. */
  'i18n.disabledLocales': z.array(z.string()).default([]),
  /** Show guests the site in their browser's language when it is enabled. */
  'i18n.detectBrowser': z.boolean().default(true),
  /** Activity types turned off in Administration → Modules (see settings/modules.ts). */
  'modules.disabled': z.array(z.string()).default([]),
  'site.defaultTimezone': z.string().default('Europe/Moscow'),
  'branding.accent': hex.default('#4f46e5'),
  'branding.logoFileId': z.string().uuid().nullable().default(null),
  'registration.enabled': z.boolean().default(false),
  'registration.requireEmailVerification': z.boolean().default(true),
  'registration.consentText': z.string().default(''),
  'auth.oauth.google': z.boolean().default(false),
  'auth.oauth.yandex': z.boolean().default(false),
  'auth.oauth.vk': z.boolean().default(false),
  'auth.oauth.keycloak': z.boolean().default(false),
  'auth.require2faForAdmins': z.boolean().default(false),
  /** Notify users of sign-ins from a new device (auth/devices.ts). */
  'auth.newSignInNotice': z.boolean().default(true),
  // Password policy (auth/password-policy.ts). It applies when a password is set.
  'password.minLength': z.coerce.number().int().min(8).max(128).default(8),
  'password.requireDigit': z.boolean().default(false),
  'password.requireLower': z.boolean().default(false),
  'password.requireUpper': z.boolean().default(false),
  'password.requireSymbol': z.boolean().default(false),
  /** How many earlier passwords cannot be used again (0 = any). */
  'password.history': z.coerce.number().int().min(0).max(20).default(0),
  /** Days until a password must be changed (0 = never). */
  'password.maxAgeDays': z.coerce.number().int().min(0).max(3650).default(0),
  // Account lockout (auth/lockout.ts): failed sign-ins within the window lock the account.
  /** Failed sign-ins that lock an account (0 = never lock). */
  'lockout.threshold': z.coerce.number().int().min(0).max(1000).default(0),
  'lockout.windowMinutes': z.coerce.number().int().min(1).max(10_080).default(30),
  'lockout.durationMinutes': z.coerce.number().int().min(1).max(10_080).default(30),
  'email.fromName': z.string().default('Hubium LMS'),
  'course.creatorRole': z.string().default('editingteacher'),
  'mentors.enabled': z.boolean().default(false),
  'ai.enabled': z.boolean().default(false),
  /** Privacy notice users accept before their first AI request (Markdown). */
  'ai.notice': z.string().max(20_000).default(''),
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

export async function getAllSettings(db: Db | Prisma.TransactionClient): Promise<AllSettings> {
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

export async function getSetting<K extends SettingKey>(
  db: Db | Prisma.TransactionClient,
  key: K,
): Promise<SettingValue<K>> {
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
  await db.$executeRaw`SELECT pg_notify('hubium_cache', 'settings')`;
}

/** The site language; the base language when the stored one is no longer installed. */
export function siteLocale(s: AllSettings): Locale {
  return isLocale(s['site.defaultLocale']) ? s['site.defaultLocale'] : BASE_LOCALE;
}

/** Languages users can choose: installed and not disabled; the site language always. */
export function enabledLocales(s: AllSettings): Locale[] {
  const site = siteLocale(s);
  const off = new Set(s['i18n.disabledLocales']);
  return locales.filter((l) => l === site || !off.has(l));
}

/** A user's own language when it can be used, else the site language. */
export function userLocale(s: AllSettings, preferred: string | null | undefined): Locale {
  return preferred && enabledLocales(s).includes(preferred) ? preferred : siteLocale(s);
}
