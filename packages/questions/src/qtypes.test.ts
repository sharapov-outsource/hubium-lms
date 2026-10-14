import { describe, expect, it } from 'vitest';
import { replay } from './behaviours.ts';
import { answerText, gradeResponse, presentQuestion, publicText, reviewParts } from './grade.ts';
import { ddwtos, gapNumbers, gapselect } from './qtypes/gaps.ts';
import { ordering } from './qtypes/ordering.ts';
import {
  DdwtosData,
  GapSelectData,
  OrderingData,
  type OrderingGrading,
  type QuestionSnapshot,
} from './types.ts';

// The new question types against the cases of Moodle's own tests (ordering) and the
// behaviour of Moodle's gap questions.

const WORDS = ['Modular', 'Object', 'Oriented', 'Dynamic', 'Learning', 'Environment'];
const orderingQ = (grading: OrderingGrading, extra: object = {}): QuestionSnapshot => ({
  id: 'q-ord',
  type: 'ORDERING',
  name: 'Moodle',
  text: '<p>Put in order</p>',
  generalFeedback: '',
  defaultMark: 1,
  data: OrderingData.parse({
    items: WORDS.map((w) => ({ id: w, text: w })),
    grading,
    feedbackCorrect: 'Отлично',
    feedbackPartial: 'Почти',
    ...extra,
  }),
});
const grade = (grading: OrderingGrading, order: string[]) =>
  gradeResponse(orderingQ(grading), { order }).fraction!;

const RIGHT = WORDS;
const REVERSED = [...WORDS].reverse();
const FOUR = ['Environment', 'Object', 'Oriented', 'Dynamic', 'Learning', 'Modular'];
const ONE = ['Oriented', 'Object', 'Dynamic', 'Learning', 'Environment', 'Modular'];
const SWAP = ['Object', 'Oriented', 'Dynamic', 'Learning', 'Environment', 'Modular'];

describe('ordering (cases of Moodle’s question_test.php)', () => {
  it.each<[OrderingGrading, string[], number | [number, number]]>([
    ['allOrNothing', RIGHT, 1],
    ['allOrNothing', REVERSED, 0],
    ['allOrNothing', ONE, 0],
    ['absolutePosition', RIGHT, 1],
    ['absolutePosition', REVERSED, 0],
    ['absolutePosition', FOUR, [0.66, 0.67]],
    ['absolutePosition', ONE, [0.16, 0.17]],
    ['relativeNextExcludeLast', RIGHT, 1],
    ['relativeNextExcludeLast', REVERSED, 0],
    ['relativeNextExcludeLast', FOUR, 0.6],
    ['relativeNextExcludeLast', ONE, 0.4],
    ['relativeNextIncludeLast', RIGHT, 1],
    ['relativeNextIncludeLast', REVERSED, 0],
    ['relativeNextIncludeLast', FOUR, 0.5],
    ['relativeOnePreviousAndNext', RIGHT, 1],
    ['relativeOnePreviousAndNext', REVERSED, 0],
    ['relativeOnePreviousAndNext', ONE, [0.33, 0.34]],
    ['relativeAllPreviousAndNext', RIGHT, 1],
    ['relativeAllPreviousAndNext', REVERSED, 0],
    ['relativeAllPreviousAndNext', ONE, 0.6],
    ['relativeAllPreviousAndNext', SWAP, [0.6, 0.7]],
    ['longestOrderedSubset', RIGHT, 1],
    ['longestOrderedSubset', REVERSED, 0],
    ['longestOrderedSubset', SWAP, [0.8, 0.84]],
    ['longestContiguousSubset', RIGHT, 1],
    ['longestContiguousSubset', REVERSED, 0],
    ['longestContiguousSubset', SWAP, [0.8, 0.84]],
    ['relativeToCorrect', RIGHT, 1],
    ['relativeToCorrect', REVERSED, 0.4],
    ['relativeToCorrect', SWAP, [0.6, 0.7]],
  ])('%s: %j', (grading, order, want) => {
    const got = grade(grading, order);
    if (typeof want === 'number') expect(got).toBeCloseTo(want, 6);
    else {
      expect(got).toBeGreaterThan(want[0]);
      expect(got).toBeLessThan(want[1]);
    }
  });

  it('never shows the items in the right order, and draws subsets as asked', () => {
    for (let seed = 1; seed < 200; seed++) {
      const shown = presentQuestion(orderingQ('absolutePosition'), seed, true).order!;
      expect(shown).not.toEqual(WORDS);
      expect([...shown].sort()).toEqual([...WORDS].sort());
    }
    const two = presentQuestion(
      orderingQ('absolutePosition', {
        items: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      }),
      7,
      true,
    );
    expect(two.order).toEqual(['b', 'a']);
    const contiguous = presentQuestion(
      orderingQ('absolutePosition', { select: 'contiguous', selectCount: 3 }),
      11,
      true,
    );
    const at = WORDS.indexOf(WORDS.find((w) => contiguous.order!.includes(w))!);
    expect([...contiguous.order!].sort()).toEqual(WORDS.slice(at, at + 3).sort());
    const random = presentQuestion(
      orderingQ('absolutePosition', { select: 'random', selectCount: 4 }),
      11,
      true,
    );
    expect(random.order).toHaveLength(4);
    // grading only looks at the drawn items
    const right = WORDS.filter((w) => random.order!.includes(w));
    expect(gradeResponse(random, { order: right }).fraction).toBe(1);
  });

  it('grades the order shown when the learner moved nothing', () => {
    const q = presentQuestion(orderingQ('absolutePosition'), 3, true);
    const untouched = gradeResponse(q, {}).fraction;
    expect(untouched).toBe(gradeResponse(q, { order: q.order }).fraction);
    expect(untouched).toBeLessThan(1);
  });

  it('feedback, item scores and parts', () => {
    const q = orderingQ('relativeNextExcludeLast');
    expect(gradeResponse(q, { order: RIGHT }).feedback).toEqual(['Отлично']);
    expect(gradeResponse(q, { order: FOUR }).feedback).toEqual(['Почти']);
    expect(gradeResponse(q, { order: REVERSED }).feedback).toEqual([]);
    expect(reviewParts(q, { order: FOUR })!.map((p) => p.fraction)).toEqual([null, 1, 1, 1, 0, 0]);
    expect(ordering.parts!(q as never, { order: FOUR })).toEqual({ right: 3, total: 5 });
    expect(
      reviewParts(orderingQ('absolutePosition', { showGrading: false }), { order: FOUR }),
    ).toBeNull();
    expect(answerText(q, { order: ['Object', 'Modular'] })).toBe(
      'Object → Modular → Oriented → Dynamic → Learning → Environment',
    );
  });
});

const TEXT = '<p>The [[1]] brown [[2]] jumped over the [[3]] dog. The [[2]] ran.</p>';
const CHOICES = [
  { id: 'c1', text: 'quick', group: 1 },
  { id: 'c2', text: 'fox', group: 2 },
  { id: 'c3', text: 'lazy', group: 3 },
  { id: 'c4', text: 'slow', group: 1 },
  { id: 'c5', text: 'dog', group: 2 },
  { id: 'c6', text: 'busy', group: 3 },
];
const gapQ = (type: 'GAPSELECT' | 'DDWTOS', extra: object = {}): QuestionSnapshot => ({
  id: 'q-gap',
  type,
  name: 'gaps',
  text: TEXT,
  generalFeedback: '',
  defaultMark: 1,
  penalty: 0.25,
  hints: [{ text: 'Ещё', clearWrong: true, showNumCorrect: true }],
  data: (type === 'GAPSELECT' ? GapSelectData : DdwtosData).parse({
    choices: type === 'DDWTOS' ? CHOICES.map((c) => ({ ...c, infinite: c.id === 'c2' })) : CHOICES,
    ...extra,
  }),
});

describe('gaps (select missing words, drag and drop into text)', () => {
  it('grades gap by gap and accepts an identical choice', () => {
    const q = gapQ('GAPSELECT');
    expect(gapNumbers(TEXT)).toEqual([1, 2, 3, 2]);
    const right = { gaps: { 1: 'c1', 2: 'c2', 3: 'c3', 4: 'c2' } };
    expect(gradeResponse(q, right).fraction).toBe(1);
    expect(gradeResponse(q, { gaps: { 1: 'c1', 2: 'c5', 3: 'c3' } }).fraction).toBe(0.5);
    expect(gradeResponse(q, {}).fraction).toBe(0);
    const twin = gapQ('GAPSELECT', {
      choices: [...CHOICES, { id: 'c7', text: 'quick', group: 1 }],
    });
    expect(gradeResponse(twin, { gaps: { ...right.gaps, 1: 'c7' } }).fraction).toBe(1);
    expect(answerText(q, { gaps: { 1: 'c4', 3: 'c3' } })).toBe(
      'The [slow] brown [—] jumped over the [lazy] dog. The [—] ran.',
    );
  });

  it('shows the gaps numbered by place, with each group’s choices shuffled', () => {
    const q = presentQuestion(gapQ('GAPSELECT'), 5, true);
    expect(publicText(q)).toBe(
      '<p>The [[1]] brown [[2]] jumped over the [[3]] dog. The [[4]] ran.</p>',
    );
    const groupsInOrder = q.choices!.map((id) => CHOICES.find((c) => c.id === id)!.group);
    expect(groupsInOrder).toEqual([...groupsInOrder].sort());
    expect(presentQuestion(gapQ('GAPSELECT', { shuffle: false }), 5, true).choices).toEqual(
      CHOICES.map((c) => c.id),
    );
  });

  it('checks the text against the choices', () => {
    const text = (t: string) => gapselect.checkText!(t, { choices: CHOICES } as never);
    expect(text('no gaps')).toMatch(/at least one gap/);
    expect(text('a [[7]] b')).toMatch(/\[\[7\]\]/);
    expect(text(TEXT)).toBeNull();
    // a drag item in two gaps must be unlimited
    const drag = (infinite: boolean) =>
      ddwtos.checkText!('a [[1]] b [[1]]', {
        choices: CHOICES.map((c) => ({ ...c, infinite })),
      } as never);
    expect(drag(false)).toMatch(/unlimited/);
    expect(drag(true)).toBeNull();
  });

  it('interactive: hints clear the wrong gaps and count back gap by gap', () => {
    const q = gapQ('DDWTOS');
    const first = { gaps: { 1: 'c1', 2: 'c5', 3: 'c6', 4: 'c2' } };
    const o = replay(q, [{ kind: 'CHECK', response: first }], 'interactive');
    expect(o.state).toBe('TRYAGAIN');
    expect(o.numCorrect).toEqual({ right: 2, total: 4 });
    const after = replay(
      q,
      [
        { kind: 'CHECK', response: first },
        { kind: 'TRYAGAIN', response: { gaps: { 1: 'c1', 4: 'c2' } } },
      ],
      'interactive',
    );
    expect(after.response).toEqual({ gaps: { 1: 'c1', 4: 'c2' } });
    // gaps 1 and 4 right throughout: 1 each; gaps 2 and 3 wrong once: 0.75 each
    const done = replay(
      q,
      [
        { kind: 'CHECK', response: first },
        { kind: 'TRYAGAIN', response: { gaps: { 1: 'c1', 4: 'c2' } } },
        { kind: 'CHECK', response: { gaps: { 1: 'c1', 2: 'c2', 3: 'c3', 4: 'c2' } } },
      ],
      'interactive',
    );
    expect(done.fraction).toBeCloseTo(0.875);
  });
});
