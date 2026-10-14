import type { Dialect } from './lexer.ts';

// The functions each dialect allows, with their argument counts. Calculated questions get
// the PHP math functions Moodle allows in them; gradebook calculations get Moodle's
// EvalMath set (case-insensitive there, as in Moodle), so formulas move between the two.

export interface FormulaFunction {
  min: number;
  /** Infinity for variadic functions. */
  max: number;
  fn: (...args: number[]) => number;
}

/** PHP's round(): half away from zero, to `precision` decimals (negative: tens, …). */
export function phpRound(x: number, precision = 0): number {
  const p = Math.trunc(precision);
  const f = 10 ** p;
  // the epsilon makes 1.005 → 1.01, as PHP's pre-rounding does
  const r = Math.round(Math.abs(x) * f * (1 + Number.EPSILON)) / f;
  return Math.sign(x) * r;
}

const one = (fn: (x: number) => number): FormulaFunction => ({ min: 1, max: 1, fn });
const many = (fn: (...xs: number[]) => number): FormulaFunction => ({
  min: 1,
  max: Number.POSITIVE_INFINITY,
  fn,
});
const sum = (...xs: number[]) => xs.reduce((a, b) => a + b, 0);

const QUESTION: Record<string, FormulaFunction> = {
  abs: one(Math.abs),
  acos: one(Math.acos),
  acosh: one(Math.acosh),
  asin: one(Math.asin),
  asinh: one(Math.asinh),
  atan: one(Math.atan),
  atan2: { min: 2, max: 2, fn: Math.atan2 },
  atanh: one(Math.atanh),
  ceil: one(Math.ceil),
  cos: one(Math.cos),
  cosh: one(Math.cosh),
  deg2rad: one((x) => (x * Math.PI) / 180),
  exp: one(Math.exp),
  expm1: one(Math.expm1),
  floor: one(Math.floor),
  fmod: { min: 2, max: 2, fn: (a, b) => a % b },
  log: {
    min: 1,
    max: 2,
    fn: (x, base) => (base === undefined ? Math.log(x) : Math.log(x) / Math.log(base)),
  },
  log10: one(Math.log10),
  log1p: one(Math.log1p),
  max: many(Math.max),
  min: many(Math.min),
  pi: { min: 0, max: 0, fn: () => Math.PI },
  pow: { min: 2, max: 2, fn: (a, b) => a ** b },
  rad2deg: one((x) => (x * 180) / Math.PI),
  round: { min: 1, max: 2, fn: (x, p) => phpRound(x, p ?? 0) },
  sin: one(Math.sin),
  sinh: one(Math.sinh),
  sqrt: one(Math.sqrt),
  tan: one(Math.tan),
  tanh: one(Math.tanh),
};

const GRADEBOOK: Record<string, FormulaFunction> = {
  sum: { min: 1, max: Number.POSITIVE_INFINITY, fn: sum },
  average: many((...xs) => sum(...xs) / xs.length),
  max: many(Math.max),
  min: many(Math.min),
  mod: { min: 2, max: 2, fn: (a, b) => a % b },
  power: { min: 2, max: 2, fn: (a, b) => a ** b },
  pi: { min: 0, max: 0, fn: () => Math.PI },
  round: { min: 1, max: 2, fn: (x, p) => phpRound(x, p ?? 0) },
  floor: one(Math.floor),
  ceil: one(Math.ceil),
  abs: one(Math.abs),
  sqrt: one(Math.sqrt),
  exp: one(Math.exp),
  // EvalMath's ln and log are both the natural logarithm
  ln: one(Math.log),
  log: one(Math.log),
  sin: one(Math.sin),
  cos: one(Math.cos),
  tan: one(Math.tan),
};

export const FUNCTIONS: Record<Dialect, Record<string, FormulaFunction>> = {
  question: QUESTION,
  gradebook: GRADEBOOK,
};

/** Names are case-insensitive in gradebook formulas, exact in question formulas. */
export function lookupFunction(dialect: Dialect, name: string): FormulaFunction | undefined {
  const table = FUNCTIONS[dialect];
  const key = dialect === 'gradebook' ? name.toLowerCase() : name;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
