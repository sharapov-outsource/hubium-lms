import type { QuestionTypeDef } from '../registry.ts';

export const description: QuestionTypeDef<'DESCRIPTION'> = {
  type: 'DESCRIPTION',
  grading: 'none',
  grade: () => ({ fraction: null, needsGrading: false, feedback: [] }),
  correctResponse: () => null,
  isAnswered: () => true,
  answerText: () => '',
  publicView: () => ({}),
  gift: (_d, { head }) => head,
};
