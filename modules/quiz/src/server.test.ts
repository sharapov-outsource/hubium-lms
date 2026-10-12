import { describe, expect, it } from 'vitest';
import { toPublicQuestion } from './public.ts';
import { QuizSettings, quizIsOpen, reviewAllowed, sumMaxMarks } from './server.ts';

describe('quiz settings', () => {
  it('applies defaults', () => {
    const s = QuizSettings.parse({});
    expect(s).toMatchObject({ attempts: 1, gradeMethod: 'HIGHEST', gradeMax: 10, perPage: 1 });
  });
  it('rejects close before open and pass above max', () => {
    expect(
      QuizSettings.safeParse({ openAt: '2026-05-02T00:00:00Z', closeAt: '2026-05-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(QuizSettings.safeParse({ gradeMax: 10, gradePass: 11 }).success).toBe(false);
    expect(QuizSettings.parse({ gradePass: '' }).gradePass).toBeUndefined();
  });
});

describe('quiz timing and review', () => {
  const now = new Date('2026-05-10T12:00:00Z');
  it('checks the open window', () => {
    expect(quizIsOpen({ openAt: null, closeAt: null }, now).ok).toBe(true);
    expect(quizIsOpen({ openAt: new Date('2026-05-11T00:00:00Z'), closeAt: null }, now)).toEqual({
      ok: false,
      reason: 'notOpen',
    });
    expect(quizIsOpen({ openAt: null, closeAt: now }, now)).toEqual({
      ok: false,
      reason: 'closed',
    });
  });
  it('gates answer review', () => {
    const base = QuizSettings.parse({});
    expect(reviewAllowed(base, null, now)).toBe(true);
    expect(reviewAllowed({ ...base, reviewAnswers: 'never' }, null, now)).toBe(false);
    const after = { ...base, reviewAnswers: 'afterClose' as const };
    expect(reviewAllowed(after, null, now)).toBe(false);
    expect(reviewAllowed(after, new Date('2026-05-11T00:00:00Z'), now)).toBe(false);
    expect(reviewAllowed(after, new Date('2026-05-09T00:00:00Z'), now)).toBe(true);
  });
  it('sums slot marks', () => {
    expect(sumMaxMarks([{ maxMark: 1 }, { maxMark: 2.5 }])).toBe(3.5);
  });
});

describe('public question', () => {
  it('never leaks fractions or feedback', () => {
    const pq = toPublicQuestion({
      slot: 1,
      page: 0,
      maxMark: '2',
      response: null,
      flagged: false,
      snapshot: {
        id: 'q',
        type: 'MULTICHOICE',
        name: 'Q',
        text: '2+2?',
        generalFeedback: 'secret',
        data: {
          single: true,
          answers: [
            { id: 'a', text: '4', fraction: 1, feedback: 'yes' },
            { id: 'b', text: '5', fraction: 0, feedback: 'no' },
          ],
        },
        order: ['b', 'a'],
      },
    });
    expect(pq.options).toEqual([
      { id: 'b', text: '5' },
      { id: 'a', text: '4' },
    ]);
    expect(pq.maxMark).toBe(2);
    const json = JSON.stringify(pq);
    expect(json).not.toContain('fraction');
    expect(json).not.toContain('secret');
    expect(json).not.toContain('yes');
  });
});
