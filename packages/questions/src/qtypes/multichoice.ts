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
      // One answer is allowed: a response that picks several earns nothing, whatever
      // order the options were stored in.
      if (chosen.length > 1) return { fraction: 0, needsGrading: false, feedback: [] };
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
  parts(q, r) {
    const right = q.data.answers.filter((a) => a.fraction > 0).map((a) => a.id);
    if (q.data.single && r.selected.length > 1) return { right: 0, total: 1 };
    return {
      right: r.selected.filter((id) => right.includes(id)).length,
      total: q.data.single ? 1 : right.length,
    };
  },
  clearWrong: (q, r) => ({
    // one answer allowed and several picked: the response is wrong as a whole, and keeping
    // the options with credit would hand over the right one for the next try
    selected:
      q.data.single && r.selected.length > 1
        ? []
        : r.selected.filter((id) => (q.data.answers.find((a) => a.id === id)?.fraction ?? 0) > 0),
  }),
  gift(d, { head, gf, fb, esc }) {
    // As Moodle writes it: "=" marks the full-credit answer of a one-answer question,
    // any other credit goes as "~%n%".
    const weight = (f: number) => (f === 0 ? '~' : `~%${Math.round(f * 1e5) / 1e3}%`);
    const items = d.answers.map(
      (a) =>
        `${d.single ? (a.fraction >= 1 ? '=' : weight(a.fraction)) : `~%${Math.round(a.fraction * 1e5) / 1e3}%`}${esc(a.text)}${fb(a.feedback)}`,
    );
    return `${head} {\n  ${items.join('\n  ')}${gf}\n}`;
  },
};
