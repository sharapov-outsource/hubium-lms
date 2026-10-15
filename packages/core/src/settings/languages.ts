import type { Db, Prisma } from '@hubium/db';
import { BASE_LOCALE, bundledLocales, isLocale, type Locale, locales } from '@hubium/i18n';
import {
  checkPack,
  type LanguageInfo,
  languageInfo,
  type PackReport,
  packContents,
  packReport,
  packSource,
} from '@hubium/i18n/packs';
import { msg } from '@hubium/module-sdk';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { publishInvalidation } from '../cache-bus.ts';
import type { RequestContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { localeCode } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';
import { loadLanguagePacks } from './language-packs.ts';
import { enabledLocales, getAllSettings, setSettings, siteLocale } from './settings.ts';

// Administration → Languages: which installed language packs users may choose, the site
// language and whether guests get their browser's language; installing a pack (a new
// language or a newer version of a bundled one), removing it, and downloading any pack.

export interface LanguageRow extends LanguageInfo {
  report: PackReport;
  /** Bundled with Hubium, installed here, or a bundled one replaced by an installed one. */
  source: 'bundled' | 'installed' | 'updated';
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
      source: packSource(code),
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
      throw new ValidationError({ defaultLocale: [msg('errors.settings.siteLanguageOn')] });
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
export async function syncSearchLanguages(db: Db | Prisma.TransactionClient): Promise<boolean> {
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

// ── installing packs ─────────────────────────────────────────────────────────

type Tree = Record<string, unknown>;

export const LANGUAGE_PACK_MAX_BYTES = 10 * 1024 * 1024;
/** Language codes as packs name their files: en, pt-BR, sr-Latn, es-419. */
const CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

export interface LanguagePackFiles {
  code: Locale;
  core: Tree;
  /** Module key → { <key>: { ... } }, as modules/<key>/messages/<code>.json holds it. */
  modules: Record<string, Tree>;
}

const fail = (message: string): never => {
  throw new ValidationError({ file: [message] });
};

function jsonObject(text: string, name: string): Tree {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail(`${name} is not valid JSON`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(`${name} is not a JSON object`);
  return v as Tree;
}

/**
 * Reads an uploaded pack: one <code>.json of interface strings, or a zip laid out as the
 * repository is (messages/<code>.json and modules/<module>/messages/<code>.json, at any
 * depth). Throws what is wrong in words an administrator can act on.
 */
export function readLanguagePack(fileName: string, data: Uint8Array): LanguagePackFiles {
  if (data.byteLength > LANGUAGE_PACK_MAX_BYTES) fail('The pack is larger than 10 MB');
  const files: Record<string, string> = {};
  if (/\.json$/i.test(fileName)) files[fileName.split(/[\\/]/).pop()!] = strFromU8(data);
  else {
    let count = 0;
    let total = 0;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(data, {
        filter: (f) => {
          if (!/\.json$/i.test(f.name) || f.name.includes('..')) return false;
          count++;
          total += f.originalSize;
          if (count > 500 || f.originalSize > 5 * 1024 * 1024 || total > 50 * 1024 * 1024)
            throw new Error('too large');
          return true;
        },
      });
    } catch {
      return fail('Upload a .zip or .json language pack (at most 500 files, 50 MB unpacked)');
    }
    for (const [name, bytes] of Object.entries(entries)) files[name] = strFromU8(bytes);
  }
  const codes = new Set<string>();
  let core: Tree | undefined;
  const modules: Record<string, Tree> = {};
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean);
    const code = parts.at(-1)!.replace(/\.json$/i, '');
    if (!CODE.test(code)) continue;
    const mod = parts.length >= 4 && parts.at(-2) === 'messages' && parts.at(-4) === 'modules';
    codes.add(code);
    const obj = jsonObject(text, path);
    if (mod) {
      const key = parts.at(-3)!;
      modules[key] = key in obj ? obj : { [key]: obj };
    } else core = obj;
  }
  if (codes.size > 1)
    fail(
      `The pack holds several languages (${[...codes].sort().join(', ')}): upload one at a time`,
    );
  const code = [...codes][0];
  if (!code) return fail('No <code>.json file was found, e.g. messages/uk.json');
  if (!core) return fail(`messages/${code}.json, the interface strings, is missing`);
  if (code === BASE_LOCALE) fail(`${BASE_LOCALE} is the base language and is not replaced`);
  return { code, core, modules };
}

/** Text search configurations of this database: a pack naming another one searches "simple". */
async function ftsConfigs(db: Db | Prisma.TransactionClient): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ cfgname: string }[]>`SELECT cfgname::text FROM pg_ts_config`;
  return new Set(rows.map((r) => r.cfgname));
}

export const installLanguagePack = defineOperation({
  name: 'site.languagePack.install',
  input: z.object({
    fileName: z.string().max(255),
    data: z.instanceof(Uint8Array),
  }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, input) {
    const pack = readLanguagePack(input.fileName, input.data);
    const language = (pack.core.$language ?? {}) as Tree;
    if (typeof language.fts === 'string' && !(await ftsConfigs(ctx.tx)).has(language.fts))
      pack.core = { ...pack.core, $language: { ...language, fts: 'simple' } };
    const report = checkPack(pack.code, pack.core, Object.values(pack.modules));
    if (!report.translated) fail('No string of the pack matches the base language');
    const data = {
      core: pack.core as Prisma.InputJsonValue,
      modules: pack.modules as Prisma.InputJsonValue,
      installedById: ctx.perm.userId,
    };
    await ctx.tx.languagePack.upsert({
      where: { code: pack.code },
      create: { code: pack.code, ...data },
      update: data,
    });
    // this process at once (search languages follow the packs); the others on commit
    await loadLanguagePacks(ctx.tx);
    await syncSearchLanguages(ctx.tx);
    await publishInvalidation(ctx.tx, 'languages');
    await logEvent(ctx.tx, {
      name: 'site.languagePack.installed',
      actorId: ctx.perm.userId,
      data: { code: pack.code, translated: report.translated, total: report.total },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return {
      code: pack.code,
      name: languageInfo(pack.code).name,
      percent: report.total ? Math.floor((report.translated / report.total) * 100) : 0,
      replaced: bundledLocales.includes(pack.code),
    };
  },
});

export const removeLanguagePack = defineOperation({
  name: 'site.languagePack.remove',
  input: z.object({ code: z.string().max(20) }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, { code }) {
    const row = await ctx.tx.languagePack.findUnique({ where: { code } });
    if (!row) throw new ValidationError({ code: [msg('errors.settings.notInstalledHere')] });
    // a bundled language stays (its bundled strings come back); another one goes
    const settings = await getAllSettings(ctx.tx);
    if (!bundledLocales.includes(code) && siteLocale(settings) === code)
      throw new ValidationError({ code: [msg('errors.settings.otherSiteLanguage')] });
    await ctx.tx.languagePack.delete({ where: { code } });
    await loadLanguagePacks(ctx.tx);
    await publishInvalidation(ctx.tx, 'languages');
    await logEvent(ctx.tx, {
      name: 'site.languagePack.removed',
      actorId: ctx.perm.userId,
      data: { code },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { code };
  },
});

/**
 * A pack as a zip laid out as the repository is: what translators start from (the base
 * language's is the template) and what is installed back.
 */
export function languagePackZip(code: Locale): Uint8Array {
  if (!isLocale(code))
    throw new ValidationError({ code: [msg('errors.settings.unknownLanguage')] });
  const { core, modules } = packContents(code);
  const json = (v: unknown) => strToU8(`${JSON.stringify(v, null, 2)}\n`);
  const files: Record<string, Uint8Array> = { [`messages/${code}.json`]: json(core) };
  for (const m of modules) {
    const key = Object.keys(m)[0];
    if (key) files[`modules/${key}/messages/${code}.json`] = json(m);
  }
  return zipSync(files);
}
