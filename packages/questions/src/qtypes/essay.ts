import type { QuestionTypeDef } from '../registry.ts';
import { textOf, visibleText } from './text.ts';

export const essay: QuestionTypeDef<'ESSAY'> = {
  type: 'ESSAY',
  grading: 'manual',
  richText: ['text'],
  // an editor's empty paragraph is no answer, and nothing for a teacher to grade
  grade: (_q, r) => ({
    fraction: null,
    needsGrading: visibleText(r.text) !== '',
    feedback: [],
  }),
  correctResponse: () => null,
  isAnswered: (r) => visibleText(textOf(r)) !== '',
  answerText: (_q, r) => textOf(r),
  publicView: (q) => ({ minWords: q.data.minWords, maxWords: q.data.maxWords }),
  gift: (_d, { head, gf }) => `${head} {${gf}}`,
};
