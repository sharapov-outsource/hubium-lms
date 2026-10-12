import { describe, expect, it } from 'vitest';
import { draftToQuestion, type QuestionDraft } from './draft.ts';
import { questionDataSchemas } from './types.ts';

const base: QuestionDraft = {
  type: 'MULTICHOICE',
  name: 'Списки',
  text: 'Какой метод добавляет элемент в конец списка?',
  explanation: 'append добавляет в конец',
  sourceIndex: 1,
  options: [],
  trueFalseAnswer: null,
  acceptedAnswers: [],
  numericAnswer: null,
  tolerance: null,
};

describe('draftToQuestion', () => {
  it('maps every draft type to valid question data', () => {
    const drafts: QuestionDraft[] = [
      {
        ...base,
        options: [
          { text: 'append', correct: true, feedback: '' },
          { text: 'pop', correct: false, feedback: '' },
          { text: '<b>', correct: false, feedback: '' },
        ],
      },
      {
        ...base,
        options: [
          { text: 'a', correct: true, feedback: '' },
          { text: 'b', correct: true, feedback: '' },
          { text: 'c', correct: false, feedback: '' },
        ],
      },
      { ...base, type: 'TRUEFALSE', trueFalseAnswer: false },
      { ...base, type: 'SHORTANSWER', acceptedAnswers: ['append', ' append ', 'list.append'] },
      { ...base, type: 'NUMERICAL', numericAnswer: 3.5, tolerance: -0.1 },
    ];
    for (const d of drafts) {
      const q = draftToQuestion(d);
      if ('error' in q) throw new Error(q.error);
      expect(questionDataSchemas[q.type].safeParse(q.data).success).toBe(true);
      expect(q.text).toBe('<p>Какой метод добавляет элемент в конец списка?</p>');
    }
    const multi = draftToQuestion(drafts[1]!);
    expect(multi).toMatchObject({ data: { single: false } });
    expect(draftToQuestion(drafts[3]!)).toMatchObject({
      data: { answers: [{ text: 'append' }, { text: 'list.append' }] },
    });
    expect(draftToQuestion(drafts[4]!)).toMatchObject({
      data: { answers: [{ value: 3.5, tolerance: 0.1 }] },
    });
  });

  it('rejects unusable drafts and escapes HTML', () => {
    expect(
      draftToQuestion({ ...base, options: [{ text: 'x', correct: false, feedback: '' }] }),
    ).toHaveProperty('error');
    expect(draftToQuestion({ ...base, type: 'TRUEFALSE' })).toHaveProperty('error');
    expect(draftToQuestion({ ...base, type: 'NUMERICAL' })).toHaveProperty('error');
    const q = draftToQuestion({
      ...base,
      type: 'TRUEFALSE',
      trueFalseAnswer: true,
      text: '<script>x</script>',
    });
    expect(q).toMatchObject({ text: '<p>&lt;script&gt;x&lt;/script&gt;</p>' });
  });
});
