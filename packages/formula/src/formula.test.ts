import { describe, expect, it } from 'vitest';
import {
  evaluate,
  FormulaError,
  LIMITS,
  parseFormula,
  phpRound,
  refs,
  rewriteRefs,
} from './index.ts';

const q = (src: string, vars: Record<string, number> = {}) =>
  evaluate(parseFormula(src, { dialect: 'question' }), (r) => {
    if (!(r.name in vars)) throw new FormulaError('unknownName', `No ${r.name}`, r.pos);
    return vars[r.name]!;
  });
const g = (src: string, items: Record<string, number> = {}) =>
  evaluate(parseFormula(src, { dialect: 'gradebook' }), (r) => items[r.name] ?? 0);
const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FormulaError) return { code: e.code, pos: e.pos };
    throw e;
  }
  throw new Error('no error');
};

describe('formulas', () => {
  it('follows the usual precedence', () => {
    expect(q('1 + 2 * 3')).toBe(7);
    expect(q('(1 + 2) * 3')).toBe(9);
    expect(q('-2^2')).toBe(-4);
    expect(q('2^3^2')).toBe(512);
    expect(q('2 ** -1')).toBe(0.5);
    expect(q('10 - 4 - 3')).toBe(3);
    expect(q('7 % 4 + 1.5e2 / .5')).toBe(303);
    expect(q('--3')).toBe(3);
  });

  it('substitutes question variables and calls PHP functions', () => {
    expect(q('{a} * {b} + 1', { a: 2.5, b: 4 })).toBe(11);
    expect(q('sqrt({x}^2 + {y}^2)', { x: 3, y: 4 })).toBe(5);
    expect(q('round(pi(), 3) + round(pi, 2)')).toBeCloseTo(6.282);
    expect(q('max(1, {a}, 3)', { a: 7 })).toBe(7);
    expect(q('log(8, 2)')).toBeCloseTo(3);
    expect(q('atan2(1, 1) * 4')).toBeCloseTo(Math.PI);
    expect(err(() => q('{z} + 1'))).toEqual({ code: 'unknownName', pos: 0 });
  });

  it('rounds half away from zero like PHP', () => {
    expect(phpRound(2.5)).toBe(3);
    expect(phpRound(-2.5)).toBe(-3);
    expect(phpRound(1.005, 2)).toBe(1.01);
    expect(phpRound(1234.5, -2)).toBe(1200);
  });

  it('reads gradebook formulas with references, case-insensitive functions and "="', () => {
    expect(g('=sum([[hw1]], [[hw2]]) * 2', { hw1: 3, hw2: 4 })).toBe(14);
    expect(g('= AVERAGE([[a]], [[b]], [[c]])', { a: 1, b: 2, c: 6 })).toBe(3);
    expect(g('mod(7, 4) + power(2, 3) + round(2.345, 2)')).toBeCloseTo(13.35);
    const f = parseFormula('=[[quiz 1]] + ##gi0192a5c2-7d1e-7000-8000-000000000001## + ##gcabc##', {
      dialect: 'gradebook',
    });
    expect(refs(f)).toEqual([
      { kind: 'idnumber', name: 'quiz 1' },
      { kind: 'item', name: '0192a5c2-7d1e-7000-8000-000000000001' },
      { kind: 'category', name: 'abc' },
    ]);
    // braces are not references in the gradebook, nor [[ ]] in questions
    expect(err(() => parseFormula('{x}', { dialect: 'gradebook' })).code).toBe('syntax');
    expect(err(() => parseFormula('[[x]]', { dialect: 'question' })).code).toBe('syntax');
  });

  it('rewrites references and keeps the rest as written', () => {
    const src = '= sum( [[hw1]],[[hw2]] ) * 2';
    const stored = rewriteRefs(src, 'gradebook', (r) => `##gi${r.name.toUpperCase()}##`);
    expect(stored).toBe('= sum( ##giHW1##,##giHW2## ) * 2');
    expect(rewriteRefs(stored, 'gradebook', (r) => `[[${r.name.toLowerCase()}]]`)).toBe(src);
  });

  it('points at mistakes', () => {
    expect(err(() => q('1 +'))).toEqual({ code: 'syntax', pos: 3 });
    expect(err(() => q('2 3'))).toEqual({ code: 'syntax', pos: 2 });
    expect(err(() => q('(1 + 2'))).toEqual({ code: 'syntax', pos: 6 });
    expect(err(() => q('1 & 2'))).toEqual({ code: 'syntax', pos: 2 });
    expect(err(() => q('foo(1)'))).toEqual({ code: 'unknownFunction', pos: 0 });
    expect(err(() => q('x + 1'))).toEqual({ code: 'unknownName', pos: 0 });
    expect(err(() => q('sqrt(1, 2)'))).toEqual({ code: 'arity', pos: 0 });
    expect(err(() => q('sqrt'))).toEqual({ code: 'syntax', pos: 0 });
    expect(err(() => g('= 1 +'))).toEqual({ code: 'syntax', pos: 5 });
    expect(err(() => q('1 / 0'))).toEqual({ code: 'domain', pos: 2 });
    expect(err(() => q('sqrt(-1)'))).toEqual({ code: 'domain', pos: 0 });
    // no way out of arithmetic: no strings, no member access, no eval
    expect(err(() => q('constructor'))).toEqual({ code: 'unknownName', pos: 0 });
    expect(err(() => q('this.x')).code).toBe('syntax');
    expect(err(() => q('"1"')).code).toBe('syntax');
  });

  it('refuses formulas that are too long, too big or too deep', () => {
    expect(err(() => q('1'.repeat(LIMITS.length + 1))).code).toBe('limit');
    expect(err(() => q(Array(300).fill('1').join('+'))).code).toBe('limit');
    expect(err(() => q(`${'('.repeat(60)}1${')'.repeat(60)}`)).code).toBe('limit');
  });

  it('evaluates random expressions the same way after printing and parsing them', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const ops = ['+', '-', '*', '/', '^'] as const;
    // an expression and its value, computed alongside
    const build = (d: number): { src: string; value: number } => {
      if (d === 0 || rand() < 0.3) {
        const v = Math.round(rand() * 9) + 1;
        return { src: String(v), value: v };
      }
      const op = ops[Math.floor(rand() * ops.length)]!;
      const l = build(d - 1);
      if (op === '^') {
        const e = Math.round(rand() * 3);
        return { src: `(${l.src} ^ ${e})`, value: l.value ** e };
      }
      const r = build(d - 1);
      const value =
        op === '+'
          ? l.value + r.value
          : op === '-'
            ? l.value - r.value
            : op === '*'
              ? l.value * r.value
              : l.value / r.value;
      return { src: `(${l.src} ${op} ${r.src})`, value };
    };
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const { src, value } = build(4);
      if (!Number.isFinite(value)) continue;
      expect(q(src)).toBeCloseTo(value, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });
});
