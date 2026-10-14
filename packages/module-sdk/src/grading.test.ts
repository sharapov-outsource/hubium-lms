import { describe, expect, it } from 'vitest';
import {
  Guide,
  guideFromShares,
  guideGrade,
  Rubric,
  rubricFillingError,
  rubricFromShares,
  rubricGrade,
  sameStructure,
} from './grading.ts';

// Rubric and marking guide grades, as Moodle's gradingform_rubric and gradingform_guide.

const rubric = (lockZeroPoints: boolean) =>
  Rubric.parse({
    lockZeroPoints,
    criteria: [
      {
        id: 'c1',
        description: 'Structure',
        levels: [
          { id: 'a', score: 1 },
          { id: 'b', score: 2 },
          { id: 'c', score: 4 },
        ],
      },
      {
        id: 'c2',
        description: 'Style',
        levels: [
          { id: 'x', score: 1 },
          { id: 'y', score: 3 },
        ],
      },
    ],
  });
const points = { min: 0, max: 100, decimals: true };

describe('rubric', () => {
  it('locked zero points: the share of the most points', () => {
    const r = rubric(true);
    // 2 + 3 of 4 + 3
    expect(
      rubricGrade(
        r,
        { c1: { levelId: 'b', remark: '' }, c2: { levelId: 'y', remark: '' } },
        points,
      ),
    ).toBeCloseTo((5 / 7) * 100);
    // the least levels are worth 2 of 7 points, not 0
    expect(
      rubricGrade(
        r,
        { c1: { levelId: 'a', remark: '' }, c2: { levelId: 'x', remark: '' } },
        points,
      ),
    ).toBeCloseTo((2 / 7) * 100);
  });

  it('unlocked: the points placed between the least and the most', () => {
    const r = rubric(false);
    expect(
      rubricGrade(
        r,
        { c1: { levelId: 'a', remark: '' }, c2: { levelId: 'x', remark: '' } },
        points,
      ),
    ).toBe(0);
    expect(
      rubricGrade(
        r,
        { c1: { levelId: 'c', remark: '' }, c2: { levelId: 'y', remark: '' } },
        points,
      ),
    ).toBe(100);
    expect(
      rubricGrade(
        r,
        { c1: { levelId: 'b', remark: '' }, c2: { levelId: 'x', remark: '' } },
        points,
      ),
    ).toBe(20);
    // on a scale of 4 grades: whole positions from 1
    expect(
      rubricGrade(
        r,
        { c1: { levelId: 'b', remark: '' }, c2: { levelId: 'y', remark: '' } },
        { min: 1, max: 4, decimals: false },
      ),
    ).toBe(3);
  });

  it('every criterion needs a level', () => {
    expect(rubricFillingError(rubric(true), { c1: { levelId: 'a', remark: '' } })).toMatch(/Style/);
    expect(
      rubricFillingError(rubric(true), {
        c1: { levelId: 'z', remark: '' },
        c2: { levelId: 'x', remark: '' },
      }),
    ).toMatch(/No such level/);
  });

  it('takes the assistant’s judgement to the nearest level', () => {
    expect(
      rubricFromShares(rubric(true), [
        { name: 'Style', score: 0.9 },
        { name: 'Structure', score: 0.4 },
      ]),
    ).toEqual({
      c1: { levelId: 'b', remark: '' },
      c2: { levelId: 'y', remark: '' },
    });
  });

  it('a used rubric keeps its criteria and levels', () => {
    const r = rubric(true);
    const renamed = {
      ...r,
      criteria: r.criteria.map((c) => ({ ...c, description: `${c.description}!` })),
    };
    expect(sameStructure(r, renamed)).toBe(true);
    expect(sameStructure(r, { ...r, criteria: r.criteria.slice(1) })).toBe(false);
  });
});

describe('marking guide', () => {
  const g = Guide.parse({
    criteria: [
      { id: 'g1', shortName: 'Argument', maxScore: 10 },
      { id: 'g2', shortName: 'Sources', maxScore: 5 },
    ],
  });
  it('the share of the most points, on the range', () => {
    expect(
      guideGrade(g, { g1: { score: 8, remark: '' }, g2: { score: 4, remark: '' } }, points),
    ).toBe(80);
    expect(
      guideGrade(
        g,
        { g1: { score: 8, remark: '' }, g2: { score: 4, remark: '' } },
        { min: 1, max: 5, decimals: false },
      ),
    ).toBe(4);
    expect(
      guideFromShares(g, [
        { name: 'Sources', score: 0.5 },
        { name: 'Argument', score: 1 },
      ]),
    ).toEqual({
      g1: { score: 10, remark: '' },
      g2: { score: 2.5, remark: '' },
    });
  });
});
