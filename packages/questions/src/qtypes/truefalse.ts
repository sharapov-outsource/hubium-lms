import type { QuestionTypeDef } from '../registry.ts';

export const truefalse: QuestionTypeDef<'TRUEFALSE'> = {
  type: 'TRUEFALSE',
  grading: 'auto',
  grade(q, r) {
    if (r.value === null) return { fraction: 0, needsGrading: false, feedback: [] };
    const fb = r.value ? q.data.feedbackTrue : q.data.feedbackFalse;
    return {
      fraction: r.value === q.data.correct ? 1 : 0,
      needsGrading: false,
      feedback: fb ? [fb] : [],
    };
  },
  correctResponse: (q) => ({ value: q.data.correct }),
  isAnswered: (r) => typeof r.value === 'boolean',
  answerText: (_q, r) => (r.value === undefined || r.value === null ? '' : String(r.value)),
  publicView: () => ({}),
  gift: (d, { head, gf }) => `${head} {${d.correct ? 'TRUE' : 'FALSE'}${gf}}`,
};
