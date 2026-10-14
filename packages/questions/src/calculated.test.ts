import { describe, expect, it } from 'vitest';
import { correctResponse, gradeResponse, presentQuestion, publicText } from './grade.ts';
import {
  checkCalculated,
  fillVars,
  formatAnswer,
  generateItems,
  variablesOf,
  variantCount,
  withinTolerance,
} from './qtypes/calculated.ts';
import { typeDef } from './qtypes/index.ts';
import {
  CalculatedData,
  CalculatedMultiData,
  type Dataset,
  type QuestionSnapshot,
} from './types.ts';

const set = (name: string, items: number[], decimals = 1): Dataset => ({
  name,
  min: 1,
  max: 10,
  decimals,
  distribution: 'uniform',
  items,
});

const calc = (data: object, extra: Partial<QuestionSnapshot> = {}): QuestionSnapshot => ({
  id: 'q-calc',
  type: 'CALCULATED',
  name: 'calc',
  text: '<p>{a} + {b} = ?</p>',
  generalFeedback: '<p>{a} plus {b} is {={a}+{b}}</p>',
  defaultMark: 1,
  data: CalculatedData.parse(data),
  ...extra,
});

describe('calculated: Moodle’s formatting and tolerances', () => {
  it('formats answers as format_float does (cases of Moodle’s tests)', () => {
    expect(formatAnswer(0.12345)).toBe('0.12345');
    expect(formatAnswer(0.12345, { length: 0, format: 'decimals' })).toBe('0');
    expect(formatAnswer(0.12345, { length: 2, format: 'decimals' })).toBe('0.12');
    expect(formatAnswer(0.12345, { length: 4, format: 'decimals' })).toBe('0.1235');
    expect(formatAnswer(0.12345, { length: 2, format: 'significant' })).toBe('0.12');
    expect(formatAnswer(0.0012345, { length: 4, format: 'decimals' })).toBe('0.0012');
    expect(formatAnswer(Number.NaN)).toBe('NAN');
    expect(formatAnswer(Number.NEGATIVE_INFINITY)).toBe('-INF');
    // significant figures in plain and scientific form
    expect(formatAnswer(1234.5678, { length: 3, format: 'significant' })).toBe('1230');
    expect(formatAnswer(123456, { length: 3, format: 'significant' })).toBe('1.23e5');
    expect(formatAnswer(0.000123456, { length: 2, format: 'significant' })).toBe('1.2e-4');
    expect(formatAnswer(-2.5, { length: 1, format: 'significant' })).toBe('-3');
    expect(formatAnswer(1.005, { length: 2, format: 'decimals' })).toBe('1.01');
    expect(formatAnswer(0.1 + 0.2)).toBe('0.3');
  });

  it('applies relative, nominal and geometric tolerances', () => {
    expect(withinTolerance(100.9, 100, 0.01, 'relative')).toBe(true);
    expect(withinTolerance(101.1, 100, 0.01, 'relative')).toBe(false);
    expect(withinTolerance(100.5, 100, 0.5, 'nominal')).toBe(true);
    expect(withinTolerance(100.6, 100, 0.5, 'nominal')).toBe(false);
    expect(withinTolerance(50, 100, 1, 'geometric')).toBe(true);
    expect(withinTolerance(200, 100, 1, 'geometric')).toBe(true);
    expect(withinTolerance(49, 100, 1, 'geometric')).toBe(false);
    expect(withinTolerance(-150, -100, 1, 'geometric')).toBe(true);
  });

  it('fills texts with values and worked-out formulas (cases of Moodle’s tests)', () => {
    expect(fillVars('{a} + {b}', { a: '1', b: '2' })).toBe('1 + 2');
    expect(fillVars('(1) {a}\n(2) {b}', { a: '1', b: '2' })).toBe('(1) 1\n(2) 2');
    expect(fillVars('= {={a} + {b}}', { a: '1', b: '2' })).toBe('= 3');
    expect(fillVars('temperatures {a} and {b}', { a: '-1', b: '2' })).toBe('temperatures -1 and 2');
    expect(fillVars('{={a}/{b}}', { a: '1', b: '3' }, { length: 3, format: 'decimals' })).toBe(
      '0.333',
    );
    expect(variablesOf(['{a} * {b}'], ['{c} and {={d}+1}'])).toEqual(['a', 'b', 'd', 'c']);
  });

  it('generates dataset items in range, rounded, the same for the same seed', () => {
    const d = { min: 2, max: 5, decimals: 2, distribution: 'uniform' as const };
    const items = generateItems(d, 50, 7);
    expect(items).toHaveLength(50);
    expect(items.every((x) => x >= 2 && x <= 5 && Number(x.toFixed(2)) === x)).toBe(true);
    expect(generateItems(d, 50, 7)).toEqual(items);
    const log = generateItems({ ...d, min: 1, max: 1000, distribution: 'loguniform' }, 100, 3);
    expect(log.every((x) => x >= 1 && x <= 1000)).toBe(true);
    // log-uniform: as many values below 31.6 as above
    expect(log.filter((x) => x < 31.6).length).toBeGreaterThan(30);
  });
});

describe('calculated questions', () => {
  const data = {
    answers: [
      { formula: '{a} + {b}', fraction: 1, tolerance: 0.01, feedback: 'Да: {={a}+{b}}' },
      { formula: '{a} - {b}', fraction: 0.5, tolerance: 0, toleranceType: 'nominal' },
    ],
    datasets: [set('a', [1, 2, 3, 4]), set('b', [10, 20, 30], 0)],
  };

  it('draws a variant and keeps its values; grades against them', () => {
    const q = presentQuestion(calc(data), 11, true);
    expect(variantCount(['a', 'b'], data.datasets)).toBe(3);
    expect(q.variant).toBeGreaterThanOrEqual(0);
    expect(q.variant).toBeLessThan(3);
    const a = Number(q.vars!.a);
    const b = Number(q.vars!.b);
    expect(q.vars!.a).toBe(a.toFixed(1));
    expect(publicText(q)).toBe(`<p>${q.vars!.a} + ${q.vars!.b} = ?</p>`);
    expect(gradeResponse(q, { text: String(a + b) })).toMatchObject({
      fraction: 1,
      // answer feedback shows values in the answer's format, as Moodle
      feedback: [`Да: ${(a + b).toFixed(2)}`],
    });
    expect(gradeResponse(q, { text: String((a + b) * 1.009) }).fraction).toBe(1);
    expect(gradeResponse(q, { text: String(a - b) }).fraction).toBe(0.5);
    expect(gradeResponse(q, { text: 'x' }).fraction).toBe(0);
    expect(correctResponse(q)).toEqual({ text: (a + b).toFixed(2) });
    expect(typeDef('CALCULATED').fillText!(q as never, q.generalFeedback)).toBe(
      `<p>${q.vars!.a} plus ${q.vars!.b} is ${a + b}</p>`,
    );
    // the same seed, the same variant; a regrade with new formulas keeps the values
    expect(presentQuestion(calc(data), 11, true).vars).toEqual(q.vars);
    const fresh = {
      ...q,
      data: CalculatedData.parse({ ...data, answers: [{ formula: '{a} * {b}', fraction: 1 }] }),
    };
    expect(gradeResponse(fresh, { text: String(a * b) }).fraction).toBe(1);
  });

  it('synchronised questions of an attempt draw the same item of shared datasets', () => {
    const shared = {
      ...data,
      datasets: [set('a', [1, 2, 3, 4, 5, 6, 7, 8]), set('b', [1, 2, 3, 4, 5, 6, 7, 8])],
    };
    const one = calc({ ...shared, shared: ['a', 'b'], synchronize: true }, { id: 'q-one' });
    const two = calc({ ...shared, shared: ['a', 'b'], synchronize: true }, { id: 'q-two-other' });
    const variants = new Set<number>();
    for (let s = 1; s < 30; s++) {
      const v1 = presentQuestion(one, s, true, { syncSeed: 1000 + s }).variant;
      const v2 = presentQuestion(two, s * 7, true, { syncSeed: 1000 + s }).variant;
      expect(v1).toBe(v2);
      variants.add(v1!);
    }
    expect(variants.size).toBeGreaterThan(1);
  });

  it('checks formulas and datasets', () => {
    expect(checkCalculated('{a} {c}', 'CALCULATED', { ...data, shared: [] })).toBe(
      'No dataset for {c}',
    );
    expect(checkCalculated('{a} {c}', 'CALCULATED', { ...data, shared: ['c'] })).toBeNull();
    expect(
      checkCalculated('', 'CALCULATED', {
        answers: [{ formula: '{a} +' }],
        datasets: data.datasets,
      }),
    ).toMatch(/^Answer 1: /);
  });

  it('multichoice: choices worked out with the values', () => {
    const q = presentQuestion(
      {
        ...calc(data),
        type: 'CALCULATEDMULTI',
        data: CalculatedMultiData.parse({
          shuffleAnswers: false,
          answers: [
            { id: 'r', text: '{={a}/{b}}', fraction: 1, length: 3 },
            { id: 'w', text: '{={a}*{b}}', fraction: 0, length: 0 },
          ],
          datasets: [set('a', [1]), set('b', [3], 0)],
        }),
      },
      5,
      true,
    );
    expect(typeDef('CALCULATEDMULTI').publicView(q as never).options).toEqual([
      { id: 'r', text: '0.333' },
      { id: 'w', text: '3' },
    ]);
    expect(gradeResponse(q, { selected: ['r'] }).fraction).toBe(1);
    expect(gradeResponse(q, correctResponse(q)).fraction).toBe(1);
  });
});
