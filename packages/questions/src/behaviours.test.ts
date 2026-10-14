import { describe, expect, it } from 'vitest';
import { clearWrongParts, maxTries, replay, type Step } from './behaviours.ts';
import { MatchData, MultichoiceData, NumericalData, type QuestionSnapshot } from './types.ts';

const numerical = (penalty: number, hints = 2): QuestionSnapshot => ({
  id: 'q1',
  type: 'NUMERICAL',
  name: 'n',
  text: '',
  generalFeedback: '',
  defaultMark: 1,
  data: NumericalData.parse({
    answers: [
      { value: 4, tolerance: 0, fraction: 1, feedback: 'Верно' },
      { value: 5, tolerance: 0, fraction: 0.5, feedback: 'Почти' },
    ],
  }),
  penalty,
  hints: Array.from({ length: hints }, (_, i) => ({
    text: `Подсказка ${i + 1}`,
    clearWrong: i === 0,
    showNumCorrect: false,
  })),
});
const save = (text: string): Step => ({ kind: 'SAVE', response: { text } });
const check = (text: string): Step => ({ kind: 'CHECK', response: { text } });

describe('question behaviours', () => {
  it('deferred: grades the last answer at the end, ignores checks', () => {
    const q = numerical(0.3);
    expect(replay(q, [save('5'), check('3'), save('4')], 'deferred')).toMatchObject({
      state: 'TODO',
      fraction: null,
      response: { text: '4' },
    });
    expect(replay(q, [save('5'), save('4'), { kind: 'FINISH' }], 'deferred')).toMatchObject({
      state: 'COMPLETE',
      fraction: 1,
      feedback: ['Верно'],
    });
  });

  it('immediate: one check grades and locks the question, without penalty', () => {
    const q = numerical(0.3);
    const o = replay(q, [check('5'), save('4'), check('4'), { kind: 'FINISH' }], 'immediate');
    expect(o).toMatchObject({
      state: 'COMPLETE',
      fraction: 0.5,
      tries: 1,
      response: { text: '5' },
    });
    // unchecked at the end: graded as it stands
    expect(replay(q, [save('4'), { kind: 'FINISH' }], 'immediate').fraction).toBe(1);
  });

  it('interactive: hints between tries and a penalty for each wrong one', () => {
    const q = numerical(0.3);
    expect(maxTries(q, 'interactive')).toBe(3);
    const first = replay(q, [check('3')], 'interactive');
    expect(first).toMatchObject({ state: 'TRYAGAIN', tries: 1, fraction: null });
    expect(first.hint?.text).toBe('Подсказка 1');
    // right on the second try: the first one costs 30 %
    const steps: Step[] = [check('3'), { kind: 'TRYAGAIN', response: {} }, check('4')];
    expect(replay(q, steps, 'interactive')).toMatchObject({ state: 'COMPLETE', tries: 2 });
    expect(replay(q, steps, 'interactive').fraction).toBeCloseTo(0.7);
    // out of tries: partly right after two wrong tries, 0.5 - 0.6 → 0
    const out = replay(
      q,
      [check('3'), { kind: 'TRYAGAIN' }, check('2'), { kind: 'TRYAGAIN' }, check('5')],
      'interactive',
    );
    expect(out).toMatchObject({ state: 'COMPLETE', fraction: 0, tries: 3 });
    // finishing while a wrong try waits counts it as the last one
    expect(replay(q, [check('5'), { kind: 'FINISH' }], 'interactive').fraction).toBe(0.5);
    // an unchecked answer after a wrong try is the next try
    const next = replay(
      q,
      [check('3'), { kind: 'TRYAGAIN' }, save('4'), { kind: 'FINISH' }],
      'interactive',
    );
    expect(next.fraction).toBeCloseTo(0.7);
    // checks after the end change nothing; a teacher's grade wins
    expect(
      replay(q, [check('4'), check('3'), { kind: 'MANUALGRADE', fraction: 0.25 }], 'interactive'),
    ).toMatchObject({ fraction: 0.25, manual: true });
  });

  it('shows the number of right parts and clears the wrong ones', () => {
    const mc: QuestionSnapshot = {
      id: 'q2',
      type: 'MULTICHOICE',
      name: 'm',
      text: '',
      generalFeedback: '',
      defaultMark: 1,
      data: MultichoiceData.parse({
        single: false,
        answers: [
          { id: 'a', text: '2', fraction: 0.5 },
          { id: 'b', text: '3', fraction: 0.5 },
          { id: 'c', text: '4', fraction: -1 },
        ],
      }),
      penalty: 0.1,
      hints: [{ text: 'Ещё раз', clearWrong: true, showNumCorrect: true }],
    };
    const o = replay(mc, [{ kind: 'CHECK', response: { selected: ['a', 'c'] } }], 'interactive');
    expect(o.numCorrect).toEqual({ right: 1, total: 2 });
    expect(clearWrongParts(mc, o.response)).toEqual({ selected: ['a'] });
    const match: QuestionSnapshot = {
      ...mc,
      type: 'MATCH',
      data: MatchData.parse({
        pairs: [
          { id: 'p1', question: '1', answer: 'один' },
          { id: 'p2', question: '2', answer: 'два' },
        ],
      }),
    };
    expect(clearWrongParts(match, { choices: { p1: 'один', p2: 'один' } })).toEqual({
      choices: { p1: 'один' },
    });
    // single answers are simply cleared when wrong
    expect(clearWrongParts(numerical(0), { text: '3' })).toEqual({});
    expect(clearWrongParts(numerical(0), { text: '4' })).toEqual({ text: '4' });
  });

  it('essays always defer to the teacher', () => {
    const essay: QuestionSnapshot = {
      id: 'q3',
      type: 'ESSAY',
      name: 'e',
      text: '',
      generalFeedback: '',
      defaultMark: 1,
      data: { minWords: 0, maxWords: 0, graderInfo: '' },
    };
    expect(maxTries(essay, 'interactive')).toBe(1);
    expect(
      replay(
        essay,
        [{ kind: 'CHECK', response: { text: 'x' } }, { kind: 'FINISH' }],
        'interactive',
      ),
    ).toMatchObject({ state: 'COMPLETE', needsGrading: false, fraction: 0 });
    expect(replay(essay, [save('Мой ответ'), { kind: 'FINISH' }], 'interactive')).toMatchObject({
      needsGrading: true,
      fraction: null,
    });
  });
});
