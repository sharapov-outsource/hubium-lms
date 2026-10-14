import { shuffle } from '../random.ts';
import type { QuestionTypeDef } from '../registry.ts';

export const multichoice: QuestionTypeDef<'MULTICHOICE'> = {
  type: 'MULTICHOICE',
  grading: 'auto',
  present(q, seed, shuffleAnswers) {
    const ids = q.data.answers.map((a) => a.id);
    return { order: shuffleAnswers && q.data.shuffleAnswers ? shuffle(ids, seed) : ids };
  },
  grade(q, r) {
    const d = q.data;
    const selected = new Set(r.selected);
    const chosen = d.answers.filter((a) => selected.has(a.id));
    if (d.single) {
      const a = chosen[0];
      return {
        fraction: a ? Math.max(0, a.fraction) : 0,
        needsGrading: false,
        feedback: a?.feedback ? [a.feedback] : [],
      };
    }
    const sum = chosen.reduce((s, a) => s + a.fraction, 0);
    return {
      fraction: Math.min(1, Math.max(0, sum)),
      needsGrading: false,
      feedback: chosen.map((a) => a.feedback).filter(Boolean),
    };
  },
  correctResponse(q) {
    const d = q.data;
    return {
      selected: d.single
        ? [[...d.answers].sort((a, b) => b.fraction - a.fraction)[0]!.id]
        : d.answers.filter((a) => a.fraction > 0).map((a) => a.id),
    };
  },
  isAnswered: (r) => Array.isArray(r.selected) && r.selected.length > 0,
  answerText(q, r) {
    const sel = (r.selected as string[]) ?? [];
    return q.data.answers
      .filter((x) => sel.includes(x.id))
      .map((x) => x.text)
      .join('; ');
  },
  publicView(q) {
    const order = q.order ?? q.data.answers.map((a) => a.id);
    return {
      multiple: !q.data.single,
      options: order
        .map((id) => q.data.answers.find((a) => a.id === id)!)
        .filter(Boolean)
        .map((a) => ({ id: a.id, text: a.text })),
    };
  },
  gift(d, { head, gf, fb, esc }) {
    const items = d.answers.map((a) =>
      d.single
        ? `${a.fraction >= 1 ? '=' : '~'}${esc(a.text)}${fb(a.feedback)}`
        : `~%${Math.round(a.fraction * 100)}%${esc(a.text)}${fb(a.feedback)}`,
    );
    return `${head} {\n  ${items.join('\n  ')}${gf}\n}`;
  },
};
