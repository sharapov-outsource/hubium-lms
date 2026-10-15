import { describe, expect, it } from 'vitest';
import {
  type Answer,
  attemptGrade,
  checkResponse,
  END,
  jumpIsCorrect,
  landOn,
  lessonPercent,
  matchesNumber,
  matchesPattern,
  type Page,
  type PageType,
  readNumber,
  resolveJump,
  type Step,
} from './engine.ts';

const ans = (id: string, jump: string, more: Partial<Answer> = {}): Answer => ({
  id,
  text: id,
  response: '',
  jump,
  score: 0,
  ...more,
});
const page = (id: string, type: PageType, answers: Answer[] = [], options = {}): Page => ({
  id,
  type,
  answers,
  options,
});
const first = <T>(xs: T[]) => xs[0]!;
const view = (pageId: string): Step => ({ pageId, kind: 'view', correct: false });
const done = (pageId: string, correct = true): Step => ({ pageId, kind: 'answer', correct });

// a content page with a branch of two questions, a cluster of two, and a last question
const lesson = [
  page('intro', 'content', [ans('go', 'next'), ans('skip', 'q3')]),
  page('q1', 'truefalse', [ans('t', 'next'), ans('f', 'this')]),
  page('q2', 'multichoice', [ans('a', 'next'), ans('b', 'previous')]),
  page('eob', 'endofbranch', [ans('back', 'lastContent')]),
  page('cl', 'cluster', [ans('pick', 'unseenCluster')]),
  page('c1', 'shortanswer', [ans('*cat*', 'unseenCluster')]),
  page('c2', 'numerical', [ans('4:6', 'unseenCluster')]),
  page('eoc', 'endofcluster', [ans('on', 'next')]),
  page('q3', 'essay', [ans('e', 'end')]),
];

describe('lesson jumps', () => {
  it('goes to this, the next, the previous page, a page, or the end', () => {
    expect(resolveJump(lesson, 'q1', 'this', [], first)).toBe('q1');
    expect(resolveJump(lesson, 'q1', 'next', [], first)).toBe('q2');
    expect(resolveJump(lesson, 'q2', 'previous', [], first)).toBe('q1');
    expect(resolveJump(lesson, 'intro', 'q3', [], first)).toBe('q3');
    expect(resolveJump(lesson, 'q3', 'next', [], first)).toBe(END);
    expect(resolveJump(lesson, 'q1', 'end', [], first)).toBe(END);
    // a page that was deleted leads on
    expect(resolveJump(lesson, 'q1', 'gone', [], first)).toBe('q2');
  });

  it('picks unseen questions of the branch, then leaves it', () => {
    expect(resolveJump(lesson, 'intro', 'unseenBranch', [view('intro')], first)).toBe('q1');
    expect(resolveJump(lesson, 'q1', 'unseenBranch', [done('q1')], first)).toBe('q2');
    expect(resolveJump(lesson, 'q2', 'unseenBranch', [done('q1'), done('q2')], first)).toBe('cl');
    expect(resolveJump(lesson, 'q2', 'randomBranch', [done('q1'), done('q2')], first)).toBe('q1');
  });

  it('goes back to the content page from the end of a branch', () => {
    expect(landOn(lesson, 'eob', [view('intro'), done('q1'), done('q2')], first)).toBe('intro');
  });

  it('passes through a cluster to its unanswered questions, then past its end', () => {
    expect(landOn(lesson, 'cl', [], first)).toBe('c1');
    expect(landOn(lesson, 'cl', [done('c1')], first)).toBe('c2');
    expect(resolveJump(lesson, 'c2', 'unseenCluster', [done('c1'), done('c2')], first)).toBe('q3');
    expect(landOn(lesson, 'eoc', [], first)).toBe('q3');
    // structural pages that only lead to each other end the lesson
    const loop = [
      page('x', 'cluster', [ans('j', 'y')]),
      page('y', 'endofcluster', [ans('k', 'x')]),
    ];
    expect(landOn(loop, 'x', [], first)).toBe(END);
  });

  it('a random content page not seen yet', () => {
    const two = [page('a', 'content'), page('b', 'content')];
    expect(resolveJump(two, 'a', 'randomContent', [view('a')], first)).toBe('b');
    expect(resolveJump(two, 'a', 'randomContent', [view('a'), view('b')], first)).toBe('a');
  });

  it('counts forward jumps as correct', () => {
    expect(jumpIsCorrect(lesson, 'q1', 'next')).toBe(true);
    expect(jumpIsCorrect(lesson, 'q1', 'q3')).toBe(true);
    expect(jumpIsCorrect(lesson, 'q1', 'this')).toBe(false);
    expect(jumpIsCorrect(lesson, 'q2', 'previous')).toBe(false);
    expect(jumpIsCorrect(lesson, 'q2', 'intro')).toBe(false);
    expect(jumpIsCorrect(lesson, 'q2', 'randomContent')).toBe(false);
  });
});

describe('lesson answers', () => {
  it('matches short answers and numbers as people type them', () => {
    expect(matchesPattern('  Black   cat ', '*cat', false)).toBe(true);
    expect(matchesPattern('Кошка', 'кошка', false)).toBe(true);
    expect(matchesPattern('Кошка', 'кошка', true)).toBe(false);
    expect(matchesPattern('a.b', 'a.b', false)).toBe(true);
    expect(matchesPattern('axb', 'a.b', false)).toBe(false);
    expect(matchesPattern('клетка и мембрана и ядро', '*клетка*мембрана*ядро*', false)).toBe(true);
    expect(matchesPattern('ядро, мембрана, клетка', '*клетка*мембрана*ядро*', false)).toBe(false);
    expect(matchesPattern('ab', 'a*b*', false)).toBe(true);
    expect(matchesPattern('ab', 'ab*b', false)).toBe(false);
    // a long answer that almost matches is checked at once, not after ages of backtracking
    const long = 'клетка мембрана '.repeat(6000);
    const started = performance.now();
    expect(matchesPattern(long, '*клетка*мембрана*ядро*', false)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
    expect(readNumber('3,5')).toBe(3.5);
    expect(readNumber('1e3')).toBe(1000);
    expect(readNumber('пять')).toBeNaN();
    expect(matchesNumber(5, '5')).toBe(true);
    expect(matchesNumber(4.5, '4:6')).toBe(true);
    expect(matchesNumber(6.1, '4:6')).toBe(false);
  });

  it('checks each kind of question', () => {
    const mc = page('m', 'multichoice', [ans('a', 'next'), ans('b', 'this'), ans('c', 'next')], {
      multiple: true,
    });
    const pages = [mc, page('z', 'content')];
    expect(checkResponse(pages, mc, { choices: ['a', 'c'] }, false)).toMatchObject({
      correct: true,
      answer: { id: 'a' },
    });
    expect(checkResponse(pages, mc, { choices: ['a'] }, false)).toMatchObject({
      correct: false,
      answer: { id: 'b' },
    });
    expect(checkResponse(pages, mc, { choices: ['a', 'b', 'c'] }, false).correct).toBe(false);
    const sa = page('s', 'shortanswer', [ans('Париж', 'next', { score: 2 })]);
    expect(checkResponse([sa], sa, { text: 'париж' }, true)).toMatchObject({
      correct: true,
      score: 2,
    });
    expect(checkResponse([sa], sa, { text: 'Лион' }, true)).toEqual({
      correct: false,
      answer: null,
      score: 0,
    });
    const match = page('p', 'matching', [ans('ok', 'next'), ans('ko', 'this')], {
      pairs: [
        { left: 'H2O', right: 'вода' },
        { left: 'NaCl', right: 'соль' },
      ],
    });
    expect(checkResponse([match], match, { matches: ['вода', 'соль'] }, false).correct).toBe(true);
    expect(checkResponse([match], match, { matches: ['соль', 'вода'] }, false)).toMatchObject({
      correct: false,
      answer: { id: 'ko' },
    });
  });
});

describe('lesson grades', () => {
  const qs = [
    page('a', 'truefalse', [ans('t', 'next', { score: 1 }), ans('f', 'this')]),
    page('b', 'shortanswer', [ans('x', 'next', { score: 3 }), ans('y', 'next', { score: 1 })]),
    page('e', 'essay', [ans('e', 'next', { score: 5 })]),
  ];
  const step = (pageId: string, correct: boolean, score = 0, essayScore?: number | null) => ({
    pageId,
    correct,
    score,
    essayScore,
  });

  it('counts every try without custom scoring', () => {
    // a wrong then a right try on a, right on b: 2 of 3
    const g = attemptGrade(qs, [step('a', false), step('a', true), step('b', true)], {
      custom: false,
      maxAttempts: 5,
      minQuestions: 0,
    });
    expect(g).toMatchObject({ earned: 2, total: 3, pending: 0 });
    expect(g.percent).toBeCloseTo(66.66667, 4);
    // tries past the allowed number do not count; too few questions count as wrong
    expect(
      attemptGrade(qs, [step('a', false), step('a', true)], {
        custom: false,
        maxAttempts: 1,
        minQuestions: 3,
      }),
    ).toMatchObject({ earned: 0, total: 3, percent: 0 });
  });

  it('takes the last try of each question with custom scoring; essays wait for a teacher', () => {
    const g = attemptGrade(
      qs,
      [step('a', true, 1), step('b', false, 1), step('e', false, 0, null)],
      { custom: true, maxAttempts: 1, minQuestions: 0 },
    );
    expect(g).toMatchObject({ earned: 2, total: 9, pending: 1 });
    expect(
      attemptGrade(qs, [step('e', false, 0, 4)], { custom: true, maxAttempts: 1, minQuestions: 0 }),
    ).toMatchObject({ earned: 4, total: 5, percent: 80, pending: 0 });
    // without questions there is nothing to grade
    expect(
      attemptGrade([page('c', 'content')], [], { custom: false, maxAttempts: 1, minQuestions: 0 })
        .percent,
    ).toBeNull();
  });

  it('keeps the best attempt or the mean', () => {
    expect(lessonPercent([40, null, 80], true)).toBe(80);
    expect(lessonPercent([40, 80], false)).toBe(60);
    expect(lessonPercent([null], false)).toBeNull();
  });
});
