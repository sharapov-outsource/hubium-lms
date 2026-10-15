import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// What people read comes from the language packs: an error, a schema's refusal, a sign-in
// refusal or an import report written as English text in the source reaches everyone in
// English. These checks read the sources for such text. The public API (packages/api)
// answers in English by design and is not read.

const REPO = join(import.meta.dirname, '../../..');
const ROOTS = [
  'packages/core/src',
  'packages/interchange/src',
  'packages/questions/src',
  'packages/module-sdk/src',
  'apps/web/src',
  'modules',
];

/** The server's own settings, read at start: what is wrong goes to the operator's log. */
const SKIP = new Set(['env.ts']);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'generated') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'test') yield* sources(path);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !SKIP.has(name)) yield path;
  }
}

const files = ROOTS.flatMap((root) =>
  [...sources(join(REPO, root))].map((path) => ({
    path: relative(REPO, path),
    src: readFileSync(path, 'utf8'),
  })),
);

/** A text for people: a capital, a small letter, and words. */
const SENTENCE = /(['"`])[A-Z][a-z][^'"`\n]*\s[^'"`\n]*\1/;

/** The text from `start` (an opening parenthesis or brace) to the one that closes it. */
function balanced(src: string, start: number): string {
  const open = src[start]!;
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Each place `re` matches, with the balanced text after it, as `file:line`. */
function findings(re: RegExp, bad: (args: string) => boolean): string[] {
  const out: string[] = [];
  for (const { path, src } of files)
    for (const m of src.matchAll(re)) {
      const at = m.index + m[0].length - 1;
      if (bad(balanced(src, at))) out.push(`${path}:${src.slice(0, m.index).split('\n').length}`);
    }
  return out;
}

const withoutMsg = (args: string) => args.replace(/\bmsg\([^)]*\)/g, '');

describe('texts for people come from the language packs', () => {
  it('errors for people carry messages, not text', () => {
    const ctor =
      /new (ValidationError|ForbiddenError|ConflictError|UnavailableError|ModuleError|AppError|ActionFailure)\(/g;
    expect(findings(ctor, (args) => SENTENCE.test(withoutMsg(args)))).toEqual([]);
  });

  it('errors passed on keep their messages', () => {
    // an AppError's fieldErrors are English text: fieldMessages, in(locale) or describeError
    const english = files.flatMap(({ path, src }) =>
      [...src.matchAll(/\be\.fieldErrors\b/g)].map(
        (m) => `${path}:${src.slice(0, m.index).split('\n').length}`,
      ),
    );
    expect(english).toEqual([]);
  });

  it("schemas refuse values with a message's key", () => {
    // .min(3, 'Too short'), .refine(fn, 'Not allowed'), { message: 'Not allowed', path }
    const checks = /\.(min|max|length|regex|email|url|refine|superRefine|nonempty)\(/g;
    const lastArg = (args: string) => SENTENCE.test(args.slice(args.lastIndexOf(',')));
    expect(findings(checks, lastArg)).toEqual([]);
    const issue = /(addIssue|refine)\([\s\S]*?\{/g;
    expect(findings(issue, (body) => /message:\s*(['"`])[A-Z][a-z][^'"`\n]*\s/.test(body))).toEqual(
      [],
    );
  });

  it('sign-in refusals carry a code, which names their message', () => {
    const refusal = /new APIError\([^()]*?\{/g;
    expect(findings(refusal, (body) => /message:/.test(body) && !/\bcode:/.test(body))).toEqual([]);
  });

  it('import reports are written in the language of whoever imports', () => {
    const report = /(warnings|errors|left)\.push\(/g;
    expect(findings(report, (args) => /^\(\s*['"`]/.test(args))).toEqual([]);
  });
});
