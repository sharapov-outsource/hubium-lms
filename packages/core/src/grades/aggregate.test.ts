import { describe, expect, it } from 'vitest';
import { aggregate, defaultLetters, formatGrade, letterFor, normalise } from './aggregate.ts';

const item = (value: number | null, max = 10, weight = 1, min = 0) => ({ value, min, max, weight });

describe('aggregate', () => {
  it('normalises within range and clamps', () => {
    expect(normalise(5, 0, 10)).toBe(0.5);
    expect(normalise(15, 0, 10)).toBe(1);
    expect(normalise(2, 2, 2)).toBe(0);
  });
  it('NATURAL sums points (10/20 + 5/10 = 15/30)', () => {
    expect(
      aggregate([item(10, 20), item(5, 10)], { method: 'NATURAL', onlyGraded: true }),
    ).toBeCloseTo(0.5);
  });
  it('NATURAL with ungraded counted as zero', () => {
    expect(
      aggregate([item(10, 10), item(null, 10)], { method: 'NATURAL', onlyGraded: false }),
    ).toBeCloseTo(0.5);
    expect(
      aggregate([item(10, 10), item(null, 10)], { method: 'NATURAL', onlyGraded: true }),
    ).toBeCloseTo(1);
  });
  it('MEAN averages normalised grades regardless of max', () => {
    expect(
      aggregate([item(10, 20), item(10, 10)], { method: 'MEAN', onlyGraded: true }),
    ).toBeCloseTo(0.75);
  });
  it('WEIGHTED_MEAN respects weights', () => {
    expect(
      aggregate([item(10, 10, 3), item(0, 10, 1)], { method: 'WEIGHTED_MEAN', onlyGraded: true }),
    ).toBeCloseTo(0.75);
  });
  it('HIGHEST, LOWEST, MEDIAN', () => {
    const xs = [item(2), item(9), item(5), item(7)];
    expect(aggregate(xs, { method: 'HIGHEST', onlyGraded: true })).toBeCloseTo(0.9);
    expect(aggregate(xs, { method: 'LOWEST', onlyGraded: true })).toBeCloseTo(0.2);
    expect(aggregate(xs, { method: 'MEDIAN', onlyGraded: true })).toBeCloseTo(0.6);
  });
  it('drop lowest and keep highest', () => {
    const xs = [item(2), item(9), item(5)];
    expect(aggregate(xs, { method: 'MEAN', onlyGraded: true, dropLowest: 1 })).toBeCloseTo(0.7);
    expect(aggregate(xs, { method: 'MEAN', onlyGraded: true, keepHighest: 1 })).toBeCloseTo(0.9);
  });
  it('excluded items and empty pools', () => {
    expect(
      aggregate([{ ...item(0), excluded: true }, item(10)], { method: 'MEAN', onlyGraded: true }),
    ).toBe(1);
    expect(aggregate([item(null)], { method: 'MEAN', onlyGraded: true })).toBeNull();
    expect(aggregate([], { method: 'NATURAL', onlyGraded: true })).toBeNull();
  });
});

describe('display', () => {
  it('maps percents to Russian marks and Latin letters', () => {
    expect(letterFor(86, defaultLetters('ru'))).toBe('5');
    expect(letterFor(69.9, defaultLetters('ru'))).toBe('3');
    expect(letterFor(10, defaultLetters('ru'))).toBe('2');
    expect(letterFor(91, defaultLetters('en'))).toBe('A');
  });
  it('formats real, percent, letter and scale grades', () => {
    const base = { min: 0, max: 20, decimals: 1 };
    expect(formatGrade(15.25, { ...base, display: 'REAL' }, defaultLetters('ru'), 'en')).toBe(
      '15.3',
    );
    expect(formatGrade(15, { ...base, display: 'PERCENT' }, defaultLetters('ru'), 'en')).toBe(
      '75%',
    );
    expect(formatGrade(18, { ...base, display: 'LETTER' }, defaultLetters('ru'))).toBe('5');
    expect(
      formatGrade(
        2,
        { ...base, display: 'REAL', scale: ['Не зачтено', 'Зачтено'] },
        defaultLetters('ru'),
      ),
    ).toBe('Зачтено');
    expect(formatGrade(null, { ...base, display: 'REAL' }, defaultLetters('ru'))).toBe('—');
  });
});
