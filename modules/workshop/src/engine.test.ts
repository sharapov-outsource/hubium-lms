import { describe, expect, it } from 'vitest';
import {
  assessmentGrade,
  bestEvaluation,
  dimensionGrades,
  fillingError,
  gradingGrade,
  randomAllocation,
  submissionGrade,
  type WorkshopForm,
} from './engine.ts';

const accumulative: WorkshopForm = {
  strategy: 'accumulative',
  dimensions: [
    { id: 'a', description: 'Идея', maxGrade: 10, weight: 1 },
    { id: 'b', description: 'Оформление', maxGrade: 5, weight: 3 },
  ],
};

describe('workshop grading strategies', () => {
  it('accumulative: weighted shares of each criterion', () => {
    const f = { a: { grade: 10 }, b: { grade: 2.5 } };
    expect(fillingError(accumulative, f)).toBeNull();
    expect(fillingError(accumulative, { a: { grade: 11 }, b: { grade: 1 } })).toMatch(/0 to 10/);
    expect(fillingError(accumulative, { a: { grade: 1 } })).toMatch(/criterion 2/);
    // (100·1 + 50·3) / 4
    expect(assessmentGrade(accumulative, f)).toBe(62.5);
  });

  it('number of errors, with a mapping or linear', () => {
    const form: WorkshopForm = {
      strategy: 'numerrors',
      dimensions: [
        { id: 'x', description: 'Есть вывод', weight: 1 },
        { id: 'y', description: 'Есть источники', weight: 1 },
      ],
    };
    const one = { x: { passed: true }, y: { passed: false } };
    expect(assessmentGrade(form, one)).toBe(50);
    expect(assessmentGrade({ ...form, mapping: { '1': 80 } }, one)).toBe(80);
    expect(fillingError(form, { x: { passed: true } })).toMatch(/assertion 2/);
  });

  it('rubric: points between the least and the most; comments give the whole', () => {
    const form: WorkshopForm = {
      strategy: 'rubric',
      dimensions: [
        {
          id: 'r',
          description: 'Аргументы',
          levels: [
            { id: 'r0', grade: 0, definition: 'нет' },
            { id: 'r1', grade: 2, definition: 'есть' },
            { id: 'r2', grade: 4, definition: 'убедительны' },
          ],
        },
      ],
    };
    expect(assessmentGrade(form, { r: { levelId: 'r1' } })).toBe(50);
    expect(dimensionGrades(form, { r: { levelId: 'r2' } })).toEqual({
      r: { grade: 100, weight: 1 },
    });
    expect(
      assessmentGrade(
        { strategy: 'comments', dimensions: [{ id: 'c', description: 'Отзыв' }] },
        {
          c: { comment: 'хорошо' },
        },
      ),
    ).toBe(100);
  });

  it('a submission gets the weighted mean of its assessments', () => {
    expect(
      submissionGrade([
        { grade: 80, weight: 1 },
        { grade: 50, weight: 2 },
        { grade: null, weight: 1 },
        { grade: 0, weight: 0 },
      ]),
    ).toBe(60);
    expect(submissionGrade([])).toBeNull();
  });
});

describe('grades for assessing', () => {
  const one = (id: string, grade: number, weight = 1) => ({
    id,
    weight,
    dims: { d: { grade, weight: 1 } },
  });

  it('those near the best assessments keep more, as Moodle reckons', () => {
    // mean 60, variance 800: the two 80s are best; 20 is 60 away → 100 − 54
    const g = bestEvaluation([one('a', 80), one('b', 80), one('c', 20)], 5);
    expect([...g.values()]).toEqual([100, 100, 46]);
    // stricter comparison takes more away
    expect(bestEvaluation([one('a', 80), one('b', 80), one('c', 20)], 1).get('c')).toBe(0);
    // a lone assessment is the best one
    expect(bestEvaluation([one('a', 30)], 5).get('a')).toBe(100);
    // nothing to compare (no weights) gives nothing
    expect(bestEvaluation([one('a', 30, 0)], 5).get('a')).toBeNull();
  });

  it('a reviewer gets the mean of their assessments', () => {
    expect(gradingGrade([100, 46, null])).toBe(73);
    expect(gradingGrade([null])).toBeNull();
  });
});

describe('random allocation', () => {
  const people = ['u1', 'u2', 'u3', 'u4'];
  const input = {
    submissions: people.map((p) => ({ id: `s-${p}`, authorId: p, groups: [p < 'u3' ? 'A' : 'B'] })),
    reviewers: people.map((p) => ({ id: p, groups: [p < 'u3' ? 'A' : 'B'] })),
    existing: [],
  };
  const same = <T>(xs: T[]) => [...xs];

  it('spreads reviews evenly, never one’s own', () => {
    const pairs = randomAllocation(
      input,
      { count: 2, per: 'submission', excludeSameGroup: false, addSelf: false, keepExisting: true },
      same,
    );
    expect(pairs).toHaveLength(8);
    for (const p of people) {
      expect(pairs.filter((x) => x.submissionId === `s-${p}`)).toHaveLength(2);
      expect(pairs.filter((x) => x.reviewerId === p)).toHaveLength(2);
      expect(pairs.some((x) => x.submissionId === `s-${p}` && x.reviewerId === p)).toBe(false);
    }
  });

  it('keeps groupmates apart and adds self-assessment when asked', () => {
    const pairs = randomAllocation(
      input,
      { count: 1, per: 'reviewer', excludeSameGroup: true, addSelf: true, keepExisting: true },
      same,
    );
    const others = pairs.filter((x) => x.submissionId !== `s-${x.reviewerId}`);
    expect(others).toHaveLength(4);
    for (const x of others) expect(x.reviewerId < 'u3').not.toBe(x.submissionId.slice(2) < 'u3');
    expect(pairs.filter((x) => x.submissionId === `s-${x.reviewerId}`)).toHaveLength(4);
  });
});
