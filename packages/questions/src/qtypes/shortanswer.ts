import type { QuestionTypeDef } from '../registry.ts';
import { normaliseText, textOf, wildcardMatch } from './text.ts';

export const shortanswer: QuestionTypeDef<'SHORTANSWER'> = {
  type: 'SHORTANSWER',
  grading: 'auto',
  grade(q, r) {
    const d = q.data;
    const given = normaliseText(r.text, d.caseSensitive);
    if (!given) return { fraction: 0, needsGrading: false, feedback: [] };
    const best = d.answers
      .filter((a) => wildcardMatch(normaliseText(a.text, d.caseSensitive), given))
      .sort((a, b) => b.fraction - a.fraction)[0];
    return {
      fraction: best?.fraction ?? 0,
      needsGrading: false,
      feedback: best?.feedback ? [best.feedback] : [],
    };
  },
  correctResponse: (q) => ({
    text: [...q.data.answers].sort((a, b) => b.fraction - a.fraction)[0]!.text,
  }),
  isAnswered: (r) => textOf(r).trim() !== '',
  answerText: (_q, r) => textOf(r),
  publicView: () => ({}),
  gift: (d, { head, gf, fb, esc }) =>
    `${head} {${d.answers.map((a) => `=${a.fraction < 1 ? `%${Math.round(a.fraction * 100)}%` : ''}${esc(a.text)}${fb(a.feedback)}`).join(' ')}${gf}}`,
};
