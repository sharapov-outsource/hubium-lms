import { type Db, Prisma } from '@hubium/db';
import {
  BASE_LOCALE,
  DEFAULT_SITE_LOCALE,
  isLocale,
  LOCALE_COOKIE,
  type Locale,
  locales,
  resolveLocale,
} from '@hubium/i18n';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import { type MsgOrText, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { issueMsg } from '../issue-messages.ts';
import { timeZone } from '../lib/zod.ts';
import { ensureLanguagePacks } from './language-packs.ts';

// Typed site settings. Each setting is declared once with a zod schema and a default;
// values are stored in SiteSetting(key, value Json) and cached in memory.

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'errors.field.colour');

export const settingDefs = {
  'site.name': z.string().min(1).max(100).default('Hubium LMS'),
  'site.defaultLocale': z
    .string()
    .refine(isLocale, 'errors.settings.unknownLanguage')
    .default(isLocale(DEFAULT_SITE_LOCALE) ? DEFAULT_SITE_LOCALE : BASE_LOCALE),
  /** Installed languages users may not choose; new languages are enabled by default. */
  'i18n.disabledLocales': z.array(z.string()).default([]),
  /** Show guests the site in their browser's language when it is enabled. */
  'i18n.detectBrowser': z.boolean().default(true),
  /** Activity types turned off in Administration → Modules (see settings/modules.ts). */
  'modules.disabled': z.array(z.string()).default([]),
  'site.defaultTimezone': timeZone.default('Europe/Moscow'),
  /** Who issues the site's Open Badges; the site name when empty. */
  'badges.issuerName': z.string().max(255).default(''),
  'badges.issuerEmail': z.union([z.literal(''), z.string().email().max(255)]).default(''),
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
  // Maintenance mode (system/maintenance.ts): only site administrators use the site.
  'maintenance.enabled': z.boolean().default(false),
  /** Shown to everyone else (plain text). */
  'maintenance.message': z.string().max(2000).default(''),
  /** When the work is expected to end; Retry-After follows it. */
  'maintenance.until': z.string().datetime({ offset: true }).nullable().default(null),
  'email.fromName': z.string().default('Hubium LMS'),
  'course.creatorRole': z.string().default('editingteacher'),
  /** Days a course or an activity stays in the recycle bin before it is deleted for good;
   *  0 keeps them until deleted by hand. */
  'recyclebin.days': z.number().int().min(0).max(3650).default(30),
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
  // settings name languages, and installed packs add languages
  await ensureLanguagePacks(db);
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
  const fieldErrors: Record<string, MsgOrText[]> = {};
  const parsed: [string, unknown][] = [];
  for (const [key, value] of Object.entries(values)) {
    const schema = settingDefs[key as SettingKey];
    if (!schema) {
      fieldErrors[key] = [msg('errors.settings.unknownSetting')];
      continue;
    }
    const r = schema.safeParse(value);
    if (r.success) parsed.push([key, r.data]);
    else fieldErrors[key] = r.error.issues.map(issueMsg);
  }
  // the course creator's role is one that can be given on a course
  const creatorRole = parsed.find(([key]) => key === 'course.creatorRole')?.[1];
  if (
    typeof creatorRole === 'string' &&
    !(await db.role.findFirst({
      where: { shortName: creatorRole, assignableLevels: { has: 'COURSE' } },
      select: { id: true },
    }))
  )
    fieldErrors['course.creatorRole'] = [msg('errors.settings.notCourseRole')];
  if (Object.keys(fieldErrors).length) throw new ValidationError(fieldErrors);
  // what changed, for the event log: who turned what off is the first question after an
  // incident
  const before = await getAllSettings(db);
  const short = (v: unknown) =>
    typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  const changed = parsed
    .filter(([key, value]) => JSON.stringify(before[key as SettingKey]) !== JSON.stringify(value))
    .map(([key, value]) => ({
      key,
      from: short(before[key as SettingKey] ?? null),
      to: short(value ?? null),
    }));
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
  if (changed.length)
    await logEvent(db, {
      name: 'site.settings.updated',
      actorId: updatedById ?? null,
      data: { changed } as Prisma.InputJsonValue,
    });
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

/**
 * The language of a request as the pages choose it without a session (sign-up, password
 * reset): the language cookie, the browser when the site allows it, the site language.
 */
export function requestLocale(s: AllSettings, h: Headers | null | undefined): Locale {
  const cookie = h
    ?.get('cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  return resolveLocale({
    cookie: cookie && decodeURIComponent(cookie),
    acceptLanguage: h?.get('accept-language'),
    site: siteLocale(s),
    enabled: enabledLocales(s),
    detectBrowser: s['i18n.detectBrowser'],
  });
}
