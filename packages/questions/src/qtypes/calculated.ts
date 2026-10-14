import { evaluate, FormulaError, parseFormula, phpRound, refs } from '@hubium/formula';
import { rng, shuffle, subSeed } from '../random.ts';
import type { GradeResult, QuestionTypeDef, QuestionView } from '../registry.ts';
import type { Dataset } from '../types.ts';
import { multichoice } from './multichoice.ts';
import { parseNumber, textOf } from './text.ts';

// Calculated questions, as Moodle's calculated, calculated simple and calculated multichoice:
// formulas of variables {x} whose values come from datasets, one item per variant. An attempt
// draws a variant and keeps its values, so grading and regrading never need the datasets.
// {=formula} in a text shows a value worked out from the variables.

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const VAR_IN_TEXT = new RegExp(`\\{(${NAME})\\}`, 'g');
const FORMULA_IN_TEXT = new RegExp(`\\{=([^{}]*(?:\\{${NAME}\\}[^{}]*)*)\\}`, 'g');

type Vars = Record<string, string>;
type Format = { format: 'decimals' | 'significant'; length: number };

/** Variables named in formulas and in texts (as {x} or inside {=…}). */
export function variablesOf(formulas: string[], texts: string[]): string[] {
  const names = new Set<string>();
  for (const f of formulas)
    try {
      for (const r of refs(parseFormula(f, { dialect: 'question' }))) names.add(r.name);
    } catch {
      // a broken formula names nothing; it is reported where it is checked
    }
  for (const t of texts) {
    for (const m of t.matchAll(FORMULA_IN_TEXT))
      for (const v of m[1]!.matchAll(VAR_IN_TEXT)) names.add(v[1]!);
    for (const m of t.replace(FORMULA_IN_TEXT, '').matchAll(VAR_IN_TEXT)) names.add(m[1]!);
  }
  return [...names];
}

/** New items of a dataset, as Moodle generates them, from a seeded generator. */
export function generateItems(
  d: Pick<Dataset, 'min' | 'max' | 'decimals' | 'distribution'>,
  count: number,
  seed: number,
): number[] {
  const r = rng(seed);
  return Array.from({ length: Math.max(0, Math.min(100, count)) }, () => {
    const x =
      d.distribution === 'loguniform'
        ? Math.exp(
            Math.log(Math.abs(d.min)) +
              (Math.log(Math.abs(d.max)) - Math.log(Math.abs(d.min))) * r(),
          )
        : d.min + (d.max - d.min) * r();
    return Number(phpRound(x, d.decimals).toFixed(d.decimals));
  });
}

/** Variants a question has: the fewest items of the datasets of its variables. */
export function variantCount(names: string[], datasets: Dataset[]): number {
  if (!names.length) return 1;
  return Math.min(...names.map((n) => datasets.find((d) => d.name === n)?.items.length ?? 0));
}

/** The values of a variant, written as their datasets round them. */
export function variantVars(names: string[], datasets: Dataset[], variant: number): Vars {
  return Object.fromEntries(
    names.map((n) => {
      const d = datasets.find((x) => x.name === n)!;
      return [n, d.items[variant]!.toFixed(d.decimals)];
    }),
  );
}

/** What is wrong with a formula as written, or null. */
export function formulaError(f: string): string | null {
  try {
    parseFormula(f, { dialect: 'question' });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** A formula worked out with the variables; throws FormulaError when it cannot be. */
export function calculate(formula: string, vars: Vars): number {
  return evaluate(parseFormula(formula, { dialect: 'question' }), ({ name, pos }) => {
    if (!(name in vars)) throw new FormulaError('unknownName', `No value for {${name}}`, pos);
    return Number(vars[name]);
  });
}

/** A number as PHP prints it (14 significant digits), which Moodle shows when unformatted. */
const plainNumber = (x: number) => String(Number(x.toPrecision(14)));

/** A number as Moodle shows an answer: `length` decimals, or `length` significant figures. */
export function formatAnswer(x: number, f?: Partial<Format>): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NAN' : x < 0 ? '-INF' : 'INF';
  if (f?.length === undefined || f.format === undefined) return plainNumber(x);
  const length = f.length;
  if (f.format === 'decimals') return phpRound(x, length).toFixed(length);
  if (!x) return '0';
  // significant figures: Moodle's format_float, string handling and all
  const sign = x < 0 ? '-' : '';
  let a = Math.abs(x);
  let p10 = 0;
  while (a < 1) {
    p10--;
    a *= 10;
  }
  while (a >= 1) {
    p10++;
    a /= 10;
  }
  a = phpRound(a, length);
  if (a >= 1) {
    p10++;
    a /= 10;
  }
  const padded = (s: string, point: boolean) => `${s}${point ? '.' : ''}${'0'.repeat(41)}x`;
  if (p10 < -2 || p10 > 4) {
    p10--;
    a *= 10;
    if (length === 1) return `${sign}${plainNumber(a)}e${p10}`;
    const digits = plainNumber(a);
    return `${sign}${padded(digits, digits.length === 1).slice(0, length + 1)}e${p10}`;
  }
  a *= Number(`1e${p10}`);
  if (0.1 <= a / Number(`1e${length}`)) return sign + plainNumber(a);
  const digits = plainNumber(a);
  const ok = length + (p10 < 1 ? 2 - p10 : 1);
  return sign + padded(digits, /^[0-9]*$/.test(digits)).slice(0, ok);
}

/** Is a response within an answer's tolerance (relative, nominal or geometric, as Moodle)? */
export function withinTolerance(
  value: number,
  answer: number,
  tolerance: number,
  type: 'relative' | 'nominal' | 'geometric',
): boolean {
  const eps = 1e-14;
  const tol = Math.abs(tolerance) + eps;
  let lo: number;
  let hi: number;
  if (type === 'relative') {
    const range = Math.abs(answer) * tol;
    [lo, hi] = [answer - range, answer + range];
  } else if (type === 'nominal') {
    const t = tolerance + eps * Math.max(Math.abs(tolerance), Math.abs(answer), eps);
    [lo, hi] = [answer - t, answer + t];
  } else {
    const q = 1 + tol;
    [lo, hi] = answer < 0 ? [answer * q, answer / q] : [answer / q, answer * q];
  }
  return lo <= value && value <= hi;
}

/** A text with {=formula} worked out (formatted when asked) and {x} replaced by its value. */
export function fillVars(text: string, vars: Vars, f?: Partial<Format>): string {
  if (!text) return text;
  return text
    .replace(FORMULA_IN_TEXT, (whole, expr: string) => {
      try {
        return formatAnswer(calculate(expr, vars), f);
      } catch {
        return whole;
      }
    })
    .replace(VAR_IN_TEXT, (whole, name: string) => vars[name] ?? whole);
}

type CalcType = 'CALCULATED' | 'CALCULATEDSIMPLE' | 'CALCULATEDMULTI';
type View = QuestionView<CalcType>;
type NumAnswer = Format & {
  formula: string;
  fraction: number;
  tolerance: number;
  toleranceType: 'relative' | 'nominal' | 'geometric';
  feedback: string;
};

const datasetsOf = (q: View): Dataset[] => q.data.datasets ?? [];
const sharedOf = (q: View): string[] => ('shared' in q.data ? q.data.shared : []);
const isMulti = (q: View) => q.type === 'CALCULATEDMULTI';

/** Every variable a calculated question uses, in its formulas and texts. */
export function calculatedVariables(q: Pick<View, 'type' | 'data' | 'text'>): string[] {
  return namesOf(q);
}

function namesOf(q: Pick<View, 'type' | 'data' | 'text'>): string[] {
  const d = q.data as { answers: { formula?: string; text?: string; feedback?: string }[] };
  return variablesOf(
    d.answers.flatMap((a) => (a.formula ? [a.formula] : [])),
    [q.text ?? '', ...d.answers.flatMap((a) => [a.text ?? '', a.feedback ?? ''])],
  );
}

/** The formulas of a calculated question's answers ({=…} in a multichoice answer's text). */
export function answerFormulas(answers: { formula?: string; text?: string }[]): string[][] {
  return answers.map((a) =>
    a.formula !== undefined
      ? [a.formula]
      : [...(a.text ?? '').matchAll(FORMULA_IN_TEXT)].map((m) => m[1]!),
  );
}

/** What is wrong with a calculated question's formulas and datasets (shared ones aside). */
export function checkCalculated(
  text: string,
  type: CalcType,
  data: { answers: { formula?: string; text?: string }[]; datasets: Dataset[]; shared?: string[] },
): string | null {
  for (const [i, a] of data.answers.entries()) {
    const formulas =
      a.formula !== undefined
        ? [a.formula]
        : [...(a.text ?? '').matchAll(FORMULA_IN_TEXT)].map((m) => m[1]!);
    for (const f of formulas)
      try {
        parseFormula(f, { dialect: 'question' });
      } catch (e) {
        return `Answer ${i + 1}: ${e instanceof Error ? e.message : String(e)}`;
      }
  }
  const names = namesOf({ type, data: data as never, text });
  const shared = new Set(data.shared ?? []);
  const missing = names.filter((n) => !shared.has(n) && !data.datasets.some((d) => d.name === n));
  if (missing.length) return `No dataset for ${missing.map((n) => `{${n}}`).join(', ')}`;
  return null;
}

function gradeNumber(q: View, text: string, vars: Vars): GradeResult & { answer?: NumAnswer } {
  const n = parseNumber(text);
  if (n === null) return { fraction: 0, needsGrading: false, feedback: [] };
  const answers = (q.data as { answers: NumAnswer[] }).answers;
  const best = answers
    .filter((a) => {
      try {
        return withinTolerance(n, calculate(a.formula, vars), a.tolerance, a.toleranceType);
      } catch {
        return false;
      }
    })
    .sort((x, y) => y.fraction - x.fraction)[0];
  return {
    fraction: best?.fraction ?? 0,
    needsGrading: false,
    feedback: best?.feedback ? [fillVars(best.feedback, vars, best)] : [],
  };
}

const multiView = (q: View, vars: Vars) => {
  const d = q.data as {
    single: boolean;
    shuffleAnswers: boolean;
    answers: (Format & { id: string; text: string; fraction: number; feedback: string })[];
  };
  return {
    type: 'MULTICHOICE' as const,
    order: q.order,
    data: {
      single: d.single,
      shuffleAnswers: d.shuffleAnswers,
      answers: d.answers.map((a) => ({
        id: a.id,
        text: fillVars(a.text, vars, a),
        fraction: a.fraction,
        feedback: fillVars(a.feedback, vars, a),
      })),
    },
  };
};

function makeCalculated<T extends CalcType>(type: T): QuestionTypeDef<T> {
  const def: QuestionTypeDef<CalcType> = {
    type,
    grading: 'auto',
    present(q, seed, shuffleAnswers, opts) {
      const names = namesOf(q);
      const n = variantCount(names, datasetsOf(q));
      if (n < 1) return { variant: 0, vars: {} };
      // synchronised: questions sharing datasets draw the same item in one attempt
      const synced = 'synchronize' in q.data && q.data.synchronize && sharedOf(q).length;
      const variant = Math.floor(
        rng(synced && opts?.syncSeed !== undefined ? opts.syncSeed : seed)() * n,
      );
      const vars = variantVars(names, datasetsOf(q), variant);
      if (!isMulti(q)) return { variant, vars };
      const d = q.data as { shuffleAnswers: boolean; answers: { id: string }[] };
      const ids = d.answers.map((a) => a.id);
      return {
        variant,
        vars,
        order: shuffleAnswers && d.shuffleAnswers ? shuffle(ids, subSeed(seed, 1)) : ids,
      };
    },
    grade(q, r) {
      const vars = q.vars ?? {};
      if (isMulti(q)) return multichoice.grade(multiView(q, vars), r as never);
      return gradeNumber(q, textOf(r as Record<string, unknown>), vars);
    },
    correctResponse(q) {
      const vars = q.vars ?? {};
      if (isMulti(q)) return multichoice.correctResponse(multiView(q, vars)) as never;
      const best = [...(q.data as { answers: NumAnswer[] }).answers].sort(
        (x, y) => y.fraction - x.fraction,
      )[0]!;
      try {
        return { text: formatAnswer(calculate(best.formula, vars), best) } as never;
      } catch {
        return null;
      }
    },
    isAnswered: (r) =>
      Array.isArray(r.selected) ? r.selected.length > 0 : textOf(r).trim() !== '',
    answerText(q, r) {
      if (isMulti(q)) return multichoice.answerText(multiView(q, q.vars ?? {}), r);
      return textOf(r);
    },
    publicView(q) {
      return isMulti(q) ? multichoice.publicView(multiView(q, q.vars ?? {})) : {};
    },
    publicText: (q, text) => fillVars(text, q.vars ?? {}),
    fillText: (q, html) => fillVars(html, q.vars ?? {}),
    checkText: (text, data) => checkCalculated(text, type, data as never),
    ...(type === 'CALCULATEDMULTI'
      ? {
          parts: (q: View, r: never) => multichoice.parts!(multiView(q, q.vars ?? {}), r),
          clearWrong: (q: View, r: never) =>
            multichoice.clearWrong!(multiView(q, q.vars ?? {}), r) as never,
        }
      : {}),
  };
  return def as unknown as QuestionTypeDef<T>;
}

export const calculated = makeCalculated('CALCULATED');
export const calculatedSimple = makeCalculated('CALCULATEDSIMPLE');
export const calculatedMulti = makeCalculated('CALCULATEDMULTI');

// ── datasets of a question ──────────────────────────────────────────────────────

type CalcData = {
  answers: { formula?: string; text?: string; feedback?: string }[];
  datasets?: Dataset[];
  shared?: string[];
};

/** A shared dataset as the database row keeps it. */
export const datasetFromRow = (r: {
  name: string;
  min: number;
  max: number;
  decimals: number;
  distribution: 'UNIFORM' | 'LOGUNIFORM';
  items: number[];
}): Dataset => ({
  name: r.name,
  min: r.min,
  max: r.max,
  decimals: r.decimals,
  distribution: r.distribution === 'LOGUNIFORM' ? 'loguniform' : 'uniform',
  items: r.items,
});

/** The datasets a calculated question draws from: its own, and the shared ones it names. */
export function datasetsFor(data: CalcData, shared: Dataset[]): Dataset[] {
  const names = new Set(data.shared ?? []);
  return [...(data.datasets ?? []), ...shared.filter((s) => names.has(s.name))];
}

/**
 * What is wrong with a calculated question's variants: a shared dataset missing, a dataset
 * with no items, or an answer that is not a number for one of them.
 */
export function checkVariants(
  type: CalcType,
  text: string,
  data: CalcData,
  shared: Dataset[],
): string | null {
  const names = calculatedVariables({ type: type as CalcType, data: data as never, text });
  const missing = (data.shared ?? []).filter(
    (n) => names.includes(n) && !shared.some((s) => s.name === n),
  );
  if (missing.length)
    return `No dataset ${missing.map((n) => `{${n}}`).join(', ')} is shared in the category`;
  const sets = datasetsFor(data, shared);
  const n = variantCount(names, sets);
  if (n < 1) return 'Every variable needs dataset items: generate them';
  const formulas = answerFormulas(data.answers);
  for (let v = 0; v < n; v++) {
    const vars = variantVars(names, sets, v);
    for (const [i, fs] of formulas.entries())
      for (const f of fs)
        try {
          calculate(f, vars);
        } catch (e) {
          return `Answer ${i + 1} is not a number for item ${v + 1} (${Object.entries(vars)
            .map(([k, x]) => `${k} = ${x}`)
            .join(', ')}): ${e instanceof Error ? e.message : String(e)}`;
        }
  }
  return null;
}
