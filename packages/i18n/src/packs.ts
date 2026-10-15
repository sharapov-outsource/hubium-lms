import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { corePacks, modulePacks } from './generated/packs.ts';
import {
  BASE_LOCALE,
  format,
  isLocale,
  type Locale,
  locales,
  type Messages,
  setExtraLocales,
} from './index.ts';

// Language packs, checked against the base language when first used. A string that is
// missing, empty, or whose placeholders or ICU syntax differ from the base is never
// shown: the site language and then the base language stand in for it. The report of
// every pack (completeness, dropped strings) is shown in Administration → Languages.

type Tree = Record<string, unknown>;

export interface LetterDefault {
  letter: string;
  lowerBound: number;
}

export interface LanguageInfo {
  code: Locale;
  /** The language's own name, e.g. Deutsch. */
  name: string;
  englishName: string;
  /** BCP-47 tag for Intl, e.g. de-DE. */
  tag: string;
  dir: 'ltr' | 'rtl';
  /** PostgreSQL text search configuration for this language. */
  fts: string;
  /** Default letter grades, highest first. */
  letters: LetterDefault[];
}

export interface PackReport {
  code: Locale;
  /** Strings of the base language. */
  total: number;
  /** Strings of this pack that can be shown. */
  translated: number;
  missing: string[];
  /** Strings that were dropped, with the reason. */
  invalid: { key: string; reason: string }[];
  /** Keys the base language does not have. */
  unknown: string[];
}

const A_TO_F: LetterDefault[] = [
  { letter: 'A', lowerBound: 90 },
  { letter: 'B', lowerBound: 80 },
  { letter: 'C', lowerBound: 70 },
  { letter: 'D', lowerBound: 60 },
  { letter: 'F', lowerBound: 0 },
];

function flatten(tree: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return out;
  for (const [k, v] of Object.entries(tree)) {
    if (!prefix && k === '$language') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

// Packs installed from Administration → Languages (kept in the database): a new language,
// or a newer version of a bundled one. The base language is always the bundled one.
const installedCore = new Map<Locale, Tree>();
const installedModules = new Map<Locale, Tree[]>();

const coreOf = (code: Locale): Tree | undefined => installedCore.get(code) ?? corePacks[code];
const modulesOf = (code: Locale): Tree[] => installedModules.get(code) ?? modulePacks[code] ?? [];

/** A language pack as installed: its core strings and one object per module. */
export interface InstalledPack {
  code: Locale;
  core: Tree;
  modules: Tree[];
}

/** Replaces the installed packs (all of them) and forgets what was worked out before. */
export function installPacks(packs: InstalledPack[]): void {
  installedCore.clear();
  installedModules.clear();
  for (const p of packs) {
    if (p.code === BASE_LOCALE) continue;
    installedCore.set(p.code, p.core);
    installedModules.set(p.code, p.modules);
  }
  setExtraLocales([...installedCore.keys()]);
  checked.clear();
  infos.clear();
  merged.clear();
  trees.clear();
}

/** Where a language's strings come from. */
export function packSource(code: Locale): 'bundled' | 'installed' | 'updated' {
  if (!installedCore.has(code)) return 'bundled';
  return corePacks[code] ? 'updated' : 'installed';
}

/** A pack's files as the repository keeps them, for download. */
export function packContents(code: Locale): { core: Tree; modules: Tree[] } {
  return { core: coreOf(code) ?? {}, modules: modulesOf(code) };
}

/** Core strings at the top, module strings under `mod`, as next-intl expects them. */
function flattenPack(core: Tree | undefined, modules: Tree[]): Map<string, unknown> {
  const out = flatten(core, '', new Map());
  for (const m of modules) flatten(m, 'mod', out);
  return out;
}

function flatPack(code: Locale): Map<string, unknown> {
  return flattenPack(coreOf(code), modulesOf(code));
}

interface Shape {
  args: Set<string>;
  tags: Set<string>;
}

/** Argument and tag names of an ICU message; throws on syntax next-intl would reject. */
function shapeOf(message: string): Shape {
  const shape: Shape = { args: new Set(), tags: new Set() };
  const walk = (els: MessageFormatElement[]) => {
    for (const el of els) {
      if (el.type === TYPE.literal || el.type === TYPE.pound) continue;
      if (el.type === TYPE.tag) {
        shape.tags.add(el.value);
        walk(el.children);
        continue;
      }
      shape.args.add(el.value);
      if (el.type === TYPE.plural || el.type === TYPE.select)
        for (const o of Object.values(el.options)) walk(o.value);
    }
  };
  walk(parse(message, { requiresOtherClause: true }));
  return shape;
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const list = (s: Set<string>) => [...s].sort().join(', ');

/** Why a translated string cannot be shown in place of `base`, or null when it can. */
export function problemOf(base: string, value: unknown): string | null {
  if (typeof value !== 'string') return 'not text';
  if (!value.trim()) return 'empty';
  let mine: Shape;
  try {
    mine = shapeOf(value);
  } catch (e) {
    return `invalid ICU message (${(e as Error).message})`;
  }
  let theirs: Shape;
  try {
    theirs = shapeOf(base);
  } catch {
    return null;
  }
  // an apostrophe before a brace quotes it in ICU and makes the placeholder disappear
  if (!same(mine.args, theirs.args))
    return `placeholders {${list(mine.args)}} instead of {${list(theirs.args)}}`;
  if (!same(mine.tags, theirs.tags))
    return `tags <${list(mine.tags)}> instead of <${list(theirs.tags)}>`;
  return null;
}

let baseFlat: Map<string, string> | undefined;
function base(): Map<string, string> {
  if (!baseFlat) {
    const flat = flatPack(BASE_LOCALE);
    if (!flat.size) throw new Error(`The base language pack (${BASE_LOCALE}) is missing`);
    baseFlat = new Map([...flat].filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return baseFlat;
}

const checked = new Map<Locale, { strings: Map<string, string>; report: PackReport }>();

function check(code: Locale) {
  let hit = checked.get(code);
  if (hit) return hit;
  hit = checkFlat(code, code === BASE_LOCALE ? new Map<string, unknown>(base()) : flatPack(code));
  checked.set(code, hit);
  return hit;
}

/** The report of a pack before it is installed. */
export function checkPack(code: Locale, core: Tree, modules: Tree[]): PackReport {
  return checkFlat(code, flattenPack(core, modules)).report;
}

function checkFlat(code: Locale, flat: Map<string, unknown>) {
  const b = base();
  const strings = new Map<string, string>();
  const report: PackReport = {
    code,
    total: b.size,
    translated: 0,
    missing: [],
    invalid: [],
    unknown: [],
  };
  for (const [key, value] of flat) {
    const baseValue = b.get(key);
    if (baseValue === undefined) {
      report.unknown.push(key);
      continue;
    }
    const problem = problemOf(baseValue, value);
    if (problem) report.invalid.push({ key, reason: problem });
    else strings.set(key, value as string);
  }
  for (const key of b.keys()) if (!flat.has(key)) report.missing.push(key);
  report.translated = strings.size;
  return { strings, report };
}

export function packReport(code: Locale): PackReport {
  return check(code).report;
}

function title(s: string | undefined, locale: string): string | undefined {
  return s ? s.charAt(0).toLocaleUpperCase(locale) + s.slice(1) : undefined;
}

function displayName(code: string, inLocale: string): string | undefined {
  try {
    return new Intl.DisplayNames([inLocale], { type: 'language' }).of(code);
  } catch {
    return undefined;
  }
}

function lettersOf(v: unknown): LetterDefault[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  const out = v.flatMap((x) =>
    Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number'
      ? [{ letter: x[0], lowerBound: x[1] }]
      : [],
  );
  return out.length === v.length ? out.sort((a, b) => b.lowerBound - a.lowerBound) : undefined;
}

const infos = new Map<Locale, LanguageInfo>();

/** The "$language" block of a pack, with defaults for what it leaves out. */
export function languageInfo(code: Locale): LanguageInfo {
  let info = infos.get(code);
  if (info) return info;
  const raw = (coreOf(code)?.$language ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof raw[k] === 'string' && raw[k] ? (raw[k] as string) : null);
  let dir: 'ltr' | 'rtl' = str('dir') === 'rtl' ? 'rtl' : 'ltr';
  if (!str('dir')) {
    try {
      const l = new Intl.Locale(code) as Intl.Locale & {
        getTextInfo?: () => { direction: string };
      };
      if (l.getTextInfo?.().direction === 'rtl') dir = 'rtl';
    } catch {}
  }
  info = {
    code,
    name: str('name') ?? title(displayName(code, code), code) ?? code,
    englishName: str('englishName') ?? displayName(code, 'en') ?? code,
    tag: str('tag') ?? code,
    dir,
    fts: str('fts') ?? 'simple',
    letters:
      lettersOf(raw.letters) ?? (code === BASE_LOCALE ? A_TO_F : languageInfo(BASE_LOCALE).letters),
  };
  infos.set(code, info);
  return info;
}

/** Every installed language. */
export function languages(): LanguageInfo[] {
  return locales.map(languageInfo);
}

function chain(locale: Locale, site?: Locale | null): Locale[] {
  return [...new Set([locale, site, BASE_LOCALE].filter(isLocale))];
}

const merged = new Map<string, Map<string, string>>();

/** Strings of `locale`, filled in from the site language and then the base language. */
function strings(locale: Locale, site?: Locale | null): Map<string, string> {
  const order = chain(locale, site);
  const key = order.join('|');
  let out = merged.get(key);
  if (!out) {
    out = new Map(base());
    for (const code of [...order].reverse())
      for (const [k, v] of check(code).strings) out.set(k, v);
    merged.set(key, out);
  }
  return out;
}

function unflatten(flat: Map<string, string>): Tree {
  const root: Tree = {};
  for (const [key, value] of flat) {
    const parts = key.split('.');
    let node = root;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Tree;
    node[parts.at(-1)!] = value;
  }
  return root;
}

const trees = new Map<string, Messages>();

/** The message tree for next-intl: core strings plus `mod`, with the fallback chain. */
export function messagesFor(locale: Locale, site?: Locale | null): Messages {
  const key = chain(locale, site).join('|');
  let tree = trees.get(key);
  if (!tree) {
    tree = unflatten(strings(locale, site)) as Messages;
    trees.set(key, tree);
  }
  return tree;
}

/** The base language's text of a key, for next-intl's fallback. */
export function baseMessage(key: string): string | undefined {
  return base().get(key);
}

/**
 * Server-side translator (emails, notifications, exports). Module strings are keyed
 * `mod.<module>.<key>`. An unknown key comes back as is.
 */
export function createTranslator(locale: Locale, site?: Locale | null) {
  const s = strings(locale, site);
  const plural = new Intl.PluralRules(languageInfo(chain(locale, site)[0]!).tag);
  return function t(key: string, values: Record<string, string | number> = {}): string {
    return format(s.get(key) ?? key, values, plural);
  };
}
