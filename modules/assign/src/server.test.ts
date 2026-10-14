import { describe, expect, it } from 'vitest';
import { AssignSettings, applyPenalty, canSubmitNow, countWords, latePenalty } from './server.ts';

describe('assign settings', () => {
  it('defaults and boolean coercion from forms', () => {
    const s = AssignSettings.parse({ allowText: 'on', allowFiles: false });
    expect(s.allowText).toBe(true);
    expect(s.allowFiles).toBe(false);
    expect(s.gradeMax).toBe(100);
  });
  it('requires at least one submission type', () => {
    expect(AssignSettings.safeParse({ allowText: false, allowFiles: false }).success).toBe(false);
  });
  it('checks date order and pass grade', () => {
    expect(
      AssignSettings.safeParse({ openAt: '2026-05-02T00:00:00Z', dueAt: '2026-05-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      AssignSettings.safeParse({ dueAt: '2026-05-02T00:00:00Z', cutoffAt: '2026-05-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(AssignSettings.safeParse({ gradeMax: 10, gradePass: 11 }).success).toBe(false);
  });
});

describe('submission window', () => {
  const now = new Date('2026-05-10T12:00:00Z');
  it('open, not yet open, closed', () => {
    expect(
      canSubmitNow(
        { openAt: null, dueAt: null, cutoffAt: null, extended: false, source: null },
        now,
      ).ok,
    ).toBe(true);
    expect(
      canSubmitNow(
        {
          openAt: new Date('2026-05-11'),
          dueAt: null,
          cutoffAt: null,
          extended: false,
          source: null,
        },
        now,
      ).reason,
    ).toBe('notOpen');
    expect(
      canSubmitNow(
        {
          openAt: null,
          dueAt: null,
          cutoffAt: new Date('2026-05-10T11:00:00Z'),
          extended: false,
          source: null,
        },
        now,
      ).reason,
    ).toBe('closed');
    // Past the due date but before cut-off is late, not closed.
    expect(
      canSubmitNow(
        {
          openAt: null,
          dueAt: new Date('2026-05-09'),
          cutoffAt: new Date('2026-05-11'),
          extended: false,
          source: null,
        },
        now,
      ).ok,
    ).toBe(true);
  });
});

describe('countWords', () => {
  it('counts words in HTML, ignoring tags and punctuation', () => {
    expect(countWords('<p>Привет, мир!</p><p>Это — тест 2 слов.</p>')).toBe(6);
    expect(countWords('<p></p>')).toBe(0);
  });
});

describe('late penalty', () => {
  const day = 86_400;
  it.each([
    // [seconds late, percent per day, cap, penalty]
    [0, 10, 100, 0],
    [-5, 10, 100, 0],
    [1, 10, 100, 10],
    [day, 10, 100, 10],
    [day + 1, 10, 100, 20],
    [3.5 * day, 10, 25, 25],
    [10 * day, 0, 100, 0],
    [2 * day, 15, 100, 30],
  ])('%s s late at %s%% a day, cap %s%%: %s%%', (late, perDay, cap, want) => {
    expect(latePenalty(late, perDay, cap)).toBe(want);
  });

  it('takes the penalty off the grade', () => {
    expect(applyPenalty(80, 25)).toBe(60);
    expect(applyPenalty(7.5, 10)).toBe(6.75);
    expect(applyPenalty(80, 0)).toBe(80);
  });
});
