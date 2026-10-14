import { shuffle, subSeed } from '../random.ts';
import type { QuestionTypeDef } from '../registry.ts';

export const match: QuestionTypeDef<'MATCH'> = {
  type: 'MATCH',
  grading: 'auto',
  present(q, seed) {
    const d = q.data;
    const choices = [...new Set([...d.pairs.map((p) => p.answer), ...d.distractors])];
    const ids = d.pairs.map((p) => p.id);
    return {
      order: d.shuffle ? shuffle(ids, seed) : ids,
      choices: shuffle(choices, subSeed(seed, 7)),
    };
  },
  grade(q, r) {
    const right = q.data.pairs.filter((p) => r.choices[p.id] === p.answer).length;
    return { fraction: right / q.data.pairs.length, needsGrading: false, feedback: [] };
  },
  correctResponse: (q) => ({
    choices: Object.fromEntries(q.data.pairs.map((p) => [p.id, p.answer])),
  }),
  isAnswered: (r) =>
    !!r.choices && Object.values(r.choices as Record<string, string>).some(Boolean),
  answerText(q, r) {
    const c = (r.choices as Record<string, string>) ?? {};
    return q.data.pairs.map((p) => `${p.question} → ${c[p.id] ?? '—'}`).join('; ');
  },
  publicView(q) {
    const order = q.order ?? q.data.pairs.map((p) => p.id);
    return {
      matchRows: order
        .map((id) => q.data.pairs.find((p) => p.id === id)!)
        .filter(Boolean)
        .map((p) => ({ id: p.id, text: p.question })),
      matchChoices: q.choices ?? q.data.pairs.map((p) => p.answer),
    };
  },
  gift: (d, { head, gf, esc }) =>
    `${head} {\n  ${[...d.pairs.map((p) => `=${esc(p.question)} -> ${esc(p.answer)}`), ...d.distractors.map((x) => `= -> ${esc(x)}`)].join('\n  ')}${gf}\n}`,
};
