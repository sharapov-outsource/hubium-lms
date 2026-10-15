import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The keys the code asks for and the keys the packs hold go together: a key the English
// pack lacks shows people the key itself, and a key nothing asks for is text translators
// keep up for nothing (or a feature left half done). The sources are read for translators
// (useTranslations, getTranslations, createTranslator) and what they are asked for:
//
// - t('a.b') and t.rich/raw/markup/has('a.b') under the translator's namespace;
// - t(cond ? 'a' : 'b'): each key the argument names;
// - t(`a.${x}`) and any `a.b.${x}` in a file with translators: every key under the prefix;
// - a full key written out ('errors.x.y', msg('mod.quiz.x')) and titled('ns', 'key').

const REPO = join(import.meta.dirname, '../../..');
const ROOTS = ['apps/web/src', 'apps/worker/src', 'apps/cli/src', 'modules', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'generated', 'dist', 'test']);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

// the packs: core's, and each module's under mod.<its keys>
const leaves = new Set<string>();
const walk = (node: Record<string, unknown>, prefix: string) => {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, key);
    else leaves.add(key);
  }
};
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
walk(json(join(REPO, 'packages/i18n/messages/en.json')), '');
for (const m of readdirSync(join(REPO, 'modules'))) {
  const path = join(REPO, 'modules', m, 'messages/en.json');
  if (statSync(join(REPO, 'modules', m)).isDirectory() && safeExists(path)) walk(json(path), 'mod');
}
function safeExists(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
/** Every key and every group of keys (a.b of a.b.c). */
const nodes = new Set(
  [...leaves].flatMap((k) => k.split('.').map((_, i, a) => a.slice(0, i + 1).join('.'))),
);

const TRANSLATOR =
  /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*(?:'([^']*)'|\{[^}]*namespace:\s*'([^']*)'[^}]*\})?\s*\)/g;
const IN_ALL = /const\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\[([\s\S]*?)\]\)/g;
const NAMED =
  /(?:get|use)Translations\(\s*(?:'([^']*)'|\{[^}]*namespace:\s*'([^']*)'[^}]*\})?\s*\)/;

/** Splits at the commas outside brackets. */
function topLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** The first argument of the call whose parenthesis opens at `at`. */
function firstArg(src: string, at: number): string {
  let depth = 0;
  let out = '';
  for (let i = at; i < src.length; i++) {
    const c = src[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (depth === 0 || (depth === 1 && c === ',')) break;
    if (i > at) out += c;
  }
  return out;
}

const used = new Set<string>();
const prefixes = new Set<string>();
const missing: string[] = [];

for (const root of ROOTS)
  for (const path of sources(join(REPO, root))) {
    const src = readFileSync(path, 'utf8');
    const rel = relative(REPO, path);
    // the translators, in order: a call takes the nearest one declared before it
    const decls: { v: string; n: string; at: number }[] = [];
    for (const m of src.matchAll(TRANSLATOR))
      decls.push({ v: m[1]!, n: m[2] ?? m[3] ?? '', at: m.index });
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*createTranslator\(/g))
      decls.push({ v: m[1]!, n: '', at: m.index });
    for (const m of src.matchAll(IN_ALL)) {
      const names = topLevel(m[1]!);
      topLevel(m[2]!).forEach((item, i) => {
        const t = NAMED.exec(item);
        if (t && names[i]) decls.push({ v: names[i]!, n: t[1] ?? t[2] ?? '', at: m.index });
      });
    }
    const nsAt = (v: string, at: number) => {
      let n: string | null = null;
      for (const d of decls) if (d.v === v && d.at < at) n = d.n;
      return n;
    };
    const full = (n: string, k: string) => (n ? `${n}.${k}` : k);
    for (const v of new Set(decls.map((d) => d.v))) {
      for (const m of src.matchAll(
        new RegExp(`\\b${v}(?:\\.rich|\\.raw|\\.markup|\\.has)?\\(\\s*'([^']+)'`, 'g'),
      )) {
        const n = nsAt(v, m.index);
        if (n === null) continue;
        const k = full(n, m[1]!);
        used.add(k);
        // t.has() asks whether a key is there
        if (!nodes.has(k) && !m[0].includes('.has(')) missing.push(`${rel}: ${k}`);
      }
      for (const m of src.matchAll(new RegExp(`\\b${v}(?:\\.rich|\\.raw|\\.markup)?\\(`, 'g'))) {
        const n = nsAt(v, m.index);
        const arg = firstArg(src, m.index + m[0].length - 1);
        if (n === null || !arg.includes('?')) continue;
        for (const q of arg.matchAll(/'([^']+)'/g)) used.add(full(n, q[1]!));
      }
      for (const m of src.matchAll(
        new RegExp(`\\b${v}(?:\\.rich|\\.raw|\\.markup|\\.has)?\\(\\s*\`([^\`$]*)\\$\\{`, 'g'),
      )) {
        const n = nsAt(v, m.index);
        if (n !== null) prefixes.add(full(n, m[1]!));
      }
    }
    for (const m of src.matchAll(/titled\(\s*'([^']+)',\s*'([^']+)'/g)) used.add(`${m[1]}.${m[2]}`);
    // a key built in a template: names.${x}, mentor${Kind}, `errors.import.${key}`
    const spaces = new Set(decls.map((d) => d.n));
    for (const m of src.matchAll(/`([a-zA-Z][\w.]*)\$\{/g)) {
      const p = m[1]!;
      if (!p.endsWith('.') && p.length < 4) continue;
      if (p.includes('.')) prefixes.add(p);
      for (const n of spaces) if (n) prefixes.add(`${n}.${p}`);
    }
    for (const m of src.matchAll(/['"`]((?:[a-zA-Z$][\w$]*\.)+[\w$]+)['"`]/g))
      if (nodes.has(m[1]!)) used.add(m[1]!);
  }

/** Asked for as itself or a group above it, or under a prefix keys are built from. */
const isUsed = (k: string) => {
  // looked up in the sets by k's own groups and prefixes: comparing every key with every
  // used key took seconds, more than a test is given on a busy CI runner
  for (let i = k.length; i > 0; i = k.lastIndexOf('.', i - 1)) {
    if (used.has(k.slice(0, i))) return true;
  }
  for (let i = 1; i <= k.length; i++) if (prefixes.has(k.slice(0, i))) return true;
  return false;
};

describe('message keys', () => {
  it('every key the code asks for is in the English packs', () => {
    expect(missing).toEqual([]);
  });

  it('every key of the English packs is asked for', () => {
    // $language describes the pack itself
    expect([...leaves].filter((k) => !k.startsWith('$') && !isUsed(k))).toEqual([]);
  });
});
