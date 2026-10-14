import { describe, expect, it } from 'vitest';
import {
  type CalcCategory,
  type CalcItem,
  type CalculationError,
  calculate,
  calculationOrder,
  displayCalculation,
  storeCalculation,
} from './calculation.ts';

const categories: CalcCategory[] = [
  { id: 'root', idNumber: null, parentId: null },
  { id: 'hw', idNumber: 'homework', parentId: 'root' },
];
const items: CalcItem[] = [
  { id: 'i1', idNumber: 'hw1', categoryId: 'hw', calculation: null },
  { id: 'i2', idNumber: 'hw2', categoryId: 'hw', calculation: null },
  { id: 'i3', idNumber: 'exam', categoryId: 'root', calculation: null },
];
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as CalculationError).code;
  }
  return null;
};

describe('gradebook calculations', () => {
  it('stores references by id and shows them by ID number', () => {
    const stored = storeCalculation('= ([[HW1]] + [[hw2]]) / 2 + [[homework]]', items, categories);
    expect(stored).toBe('= (##gii1## + ##gii2##) / 2 + ##gchw##');
    expect(displayCalculation(stored, items, categories)).toBe(
      '= ([[hw1]] + [[hw2]]) / 2 + [[homework]]',
    );
    // a formula without "=" gets one; what is gone shows as [[?]]
    expect(storeCalculation('[[exam]] * 2', items, categories)).toBe('=##gii3## * 2');
    expect(displayCalculation('=##gigone## + 1', items, categories)).toBe('=[[?]] + 1');
    expect(code(() => storeCalculation('[[nope]] + 1', items, categories))).toBe('unknownIdNumber');
    expect(code(() => storeCalculation('[[hw1]] +', items, categories))).toBe('syntax');
    expect(code(() => storeCalculation('foo([[hw1]])', items, categories))).toBe('unknownFunction');
  });

  it('orders calculated items after what they use, and refuses cycles', () => {
    const withCalc = (extra: CalcItem[]) => [...items, ...extra];
    const a = { id: 'a', idNumber: 'a', categoryId: 'root', calculation: '=##gii1## * 2' };
    const b = { id: 'b', idNumber: 'b', categoryId: 'root', calculation: '=##gia## + 1' };
    expect(calculationOrder(withCalc([b, a]), categories)).toEqual(['a', 'b']);
    // a calculated item inside a category a formula uses comes first
    const inHw = { id: 'c', idNumber: 'c', categoryId: 'hw', calculation: '=##gii1##' };
    const usesHw = { id: 'd', idNumber: 'd', categoryId: 'root', calculation: '=##gchw##' };
    expect(calculationOrder(withCalc([usesHw, inHw]), categories)).toEqual(['c', 'd']);
    // itself, each other, or a category it counts in
    const self = { id: 's', idNumber: 's', categoryId: 'root', calculation: '=##gis## + 1' };
    expect(code(() => calculationOrder(withCalc([self]), categories))).toBe('cycle');
    const x = { id: 'x', idNumber: 'x', categoryId: 'root', calculation: '=##giy##' };
    const y = { id: 'y', idNumber: 'y', categoryId: 'root', calculation: '=##gix##' };
    expect(code(() => calculationOrder(withCalc([x, y]), categories))).toBe('cycle');
    const ownCat = { id: 'o', idNumber: 'o', categoryId: 'hw', calculation: '=##gchw##' };
    expect(code(() => calculationOrder(withCalc([ownCat]), categories))).toBe('cycle');
  });

  it('computes as Moodle: empty counts as 0 unless everything is empty', () => {
    const v = (values: Record<string, number | null | undefined>) => (r: { id: string }) =>
      values[r.id];
    const f = '=##gii1## + ##gii2##';
    expect(calculate(f, v({ i1: 3, i2: 4 }))).toBe(7);
    expect(calculate(f, v({ i1: 3, i2: null }))).toBe(3);
    expect(calculate(f, v({ i1: null, i2: null }))).toBeNull();
    // a reference that is gone: no grade
    expect(calculate(f, v({ i1: 3 }))).toBeNull();
    // division by zero: no grade
    expect(calculate('=##gii1## / ##gii2##', v({ i1: 3, i2: 0 }))).toBeNull();
    expect(calculate('=sum(##gii1##, ##gii2##) / 2', v({ i1: 6, i2: 8 }))).toBe(7);
    expect(calculate('=10', v({}))).toBe(10);
  });
});
