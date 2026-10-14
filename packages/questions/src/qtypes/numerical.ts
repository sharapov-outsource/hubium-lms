import type { QuestionTypeDef } from '../registry.ts';
import { parseNumber, textOf } from './text.ts';

export const numerical: QuestionTypeDef<'NUMERICAL'> = {
  type: 'NUMERICAL',
  grading: 'auto',
  grade(q, r) {
    const n = parseNumber(r.text);
    if (n === null) return { fraction: 0, needsGrading: false, feedback: [] };
    const best = q.data.answers
      .filter((a) => Math.abs(n - a.value) <= a.tolerance + 1e-12)
      .sort((a, b) => b.fraction - a.fraction)[0];
    return {
      fraction: best?.fraction ?? 0,
      needsGrading: false,
      feedback: best?.feedback ? [best.feedback] : [],
    };
  },
  correctResponse: (q) => ({
    text: String([...q.data.answers].sort((a, b) => b.fraction - a.fraction)[0]!.value),
  }),
  isAnswered: (r) => textOf(r).trim() !== '',
  answerText: (_q, r) => textOf(r),
  publicView: () => ({}),
  gift: (d, { head, gf, fb }) =>
    `${head} {#${d.answers.map((a) => `=${a.fraction < 1 ? `%${Math.round(a.fraction * 100)}%` : ''}${a.value}:${a.tolerance}${fb(a.feedback)}`).join(' ')}${gf}}`,
};
