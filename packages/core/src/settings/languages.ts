import type { Db } from '@hubium/db';
import { BASE_LOCALE, isLocale, type Locale, locales } from '@hubium/i18n';
import { type LanguageInfo, languageInfo, type PackReport, packReport } from '@hubium/i18n/packs';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { localeCode } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';
import { enabledLocales, getAllSettings, setSettings, siteLocale } from './settings.ts';

// Administration → Languages: which installed language packs users may choose, the site
// language and whether guests get their browser's language.

export interface LanguageRow extends LanguageInfo {
  report: PackReport;
  /** Share of the base language's strings this pack has, 0..100. */
  percent: number;
  enabled: boolean;
  isSite: boolean;
  isBase: boolean;
  /** Users who chose this language. */
  users: number;
}

export async function languageOverview(ctx: RequestContext): Promise<{
  rows: LanguageRow[];
  detectBrowser: boolean;
  /** Users whose language is not installed or not enabled: they see the site language. */
  orphanedUsers: number;
}> {
  await ctx.perm.require('site:config');
  const settings = await getAllSettings(ctx.db);
  const enabled = new Set(enabledLocales(settings));
  const site = siteLocale(settings);
  const counts = await ctx.db.user.groupBy({
    by: ['locale'],
    where: { deletedAt: null, locale: { not: null } },
    _count: { _all: true },
  });
  const usersOf = new Map(counts.map((c) => [c.locale, c._count._all]));
  const rows = locales.map((code): LanguageRow => {
    const report = packReport(code);
    return {
      ...languageInfo(code),
      report,
      percent: report.total ? Math.floor((report.translated / report.total) * 1000) / 10 : 0,
      enabled: enabled.has(code),
      isSite: code === site,
      isBase: code === BASE_LOCALE,
      users: usersOf.get(code) ?? 0,
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name, site));
  const orphanedUsers = counts
    .filter((c) => c.locale && !enabled.has(c.locale))
    .reduce((s, c) => s + c._count._all, 0);
  return { rows, detectBrowser: settings['i18n.detectBrowser'], orphanedUsers };
}

export const saveLanguageSettings = defineOperation({
  name: 'site.languages',
  input: z.object({
    defaultLocale: localeCode,
    enabled: z.array(localeCode).min(1),
    detectBrowser: z.boolean(),
  }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, input) {
    if (!input.enabled.includes(input.defaultLocale))
      throw new ValidationError({ defaultLocale: ['The site language must stay enabled'] });
    const disabled = locales.filter((l) => !input.enabled.includes(l));
    await setSettings(
      ctx.tx,
      {
        'site.defaultLocale': input.defaultLocale,
        'i18n.disabledLocales': disabled,
        'i18n.detectBrowser': input.detectBrowser,
      },
      ctx.perm.userId ?? undefined,
    );
    await logEvent(ctx.tx, {
      name: 'site.languages.updated',
      actorId: ctx.perm.userId,
      data: { defaultLocale: input.defaultLocale, disabled, detectBrowser: input.detectBrowser },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { defaultLocale: input.defaultLocale as Locale, disabled };
  },
});

/** Enabled languages as the pickers list them: code and own name, by name. */
export async function enabledLanguages(db: Db): Promise<{ code: Locale; name: string }[]> {
  const settings = await getAllSettings(db);
  const site = siteLocale(settings);
  return enabledLocales(settings)
    .map((code) => ({ code, name: languageInfo(code).name }))
    .sort((a, b) => a.name.localeCompare(b.name, site));
}

/**
 * Languages a text in several languages is edited in: the site language first (required),
 * the other enabled languages, and any language the text already has, so saving keeps it.
 */
export async function editingLanguages(
  db: Db,
  existing?: unknown,
): Promise<{ code: Locale; name: string }[]> {
  const settings = await getAllSettings(db);
  const site = siteLocale(settings);
  const codes = new Set(enabledLocales(settings));
  if (existing && typeof existing === 'object')
    for (const k of Object.keys(existing)) if (isLocale(k)) codes.add(k);
  codes.delete(site);
  const rest = [...codes]
    .map((code) => ({ code, name: languageInfo(code).name }))
    .sort((a, b) => a.name.localeCompare(b.name, site));
  return [{ code: site, name: languageInfo(site).name }, ...rest];
}

const FTS_KEY = 'search.ftsConfigs';

/**
 * Keeps the database's search languages in step with the installed packs: the seed stores
 * their PostgreSQL configurations and, when they changed, rebuilds the search vectors.
 */
export async function syncSearchLanguages(db: Db): Promise<boolean> {
  const configs = [...new Set(locales.map((l) => languageInfo(l).fts))]
    .filter((c) => c !== 'simple')
    .sort();
  const row = await db.siteSetting.findUnique({ where: { key: FTS_KEY } });
  if (JSON.stringify(row?.value) === JSON.stringify(configs)) return false;
  await db.siteSetting.upsert({
    where: { key: FTS_KEY },
    create: { key: FTS_KEY, value: configs },
    update: { value: configs },
  });
  await db.$executeRaw`SELECT hubium_reindex_search()`;
  return true;
}
