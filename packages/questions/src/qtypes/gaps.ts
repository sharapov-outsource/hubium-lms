import { problem } from '../problem.ts';
import { shuffle, subSeed } from '../random.ts';
import type { QuestionTypeDef, QuestionView } from '../registry.ts';
import { combinedFeedback } from './combined.ts';
import { countbackByParts } from './countback.ts';

// Gaps in the question text, as Moodle's "select missing words" (GAPSELECT) and "drag and
// drop into text" (DDWTOS): [[n]] marks a gap whose right answer is choice n, and the gap
// takes the choices of that choice's group. Gaps are numbered 1, 2, … in the order of the
// text; the learner sees them renumbered so the numbers tell nothing.

type GapType = 'GAPSELECT' | 'DDWTOS';
type View = QuestionView<GapType>;
type Choice = { id: string; text: string; group: number; infinite?: boolean };

const GAP = /\[\[(\d+)\]\]/g;

/** The choice number each gap of the text names, in the order of the text. */
export function gapNumbers(text: string): number[] {
  return [...text.matchAll(GAP)].map((m) => Number(m[1]));
}

/** The text with its gaps numbered by place ([[1]], [[2]], …) instead of by right choice. */
export function placeGaps(text: string): string {
  let k = 0;
  return text.replace(GAP, () => `[[${++k}]]`);
}

const choicesOf = (q: View): Choice[] => q.data.choices;

/** The right choice of each gap (by place), or undefined when the gap names none. */
function rightChoices(q: View): (Choice | undefined)[] {
  const list = choicesOf(q);
  return gapNumbers(q.text ?? '').map((n) => list[n - 1]);
}

/** Choices with the same text in the same group are interchangeable. */
const sameChoice = (a: Choice | undefined, b: Choice | undefined) =>
  !!a && !!b && a.text === b.text && a.group === b.group;

function rightGaps(q: View, gaps: Record<string, string>): boolean[] {
  const byId = new Map(choicesOf(q).map((c) => [c.id, c]));
  return rightChoices(q).map((want, i) => sameChoice(byId.get(gaps[String(i + 1)] ?? ''), want));
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

function makeGapType<T extends GapType>(type: T): QuestionTypeDef<T> {
  const def: QuestionTypeDef<GapType> = {
    type,
    grading: 'auto',
    present(q, seed, shuffleAnswers) {
      const list = choicesOf(q);
      if (!q.data.shuffle || !shuffleAnswers) return { choices: list.map((c) => c.id) };
      // shuffled within each group, groups kept in order
      const groups = [...new Set(list.map((c) => c.group))].sort((a, b) => a - b);
      return {
        choices: groups.flatMap((g) =>
          shuffle(
            list.filter((c) => c.group === g).map((c) => c.id),
            subSeed(seed, g),
          ),
        ),
      };
    },
    grade(q, r) {
      const right = rightGaps(q, r.gaps);
      const fraction = right.length ? right.filter(Boolean).length / right.length : 0;
      return { fraction, needsGrading: false, feedback: combinedFeedback(q.data, fraction) };
    },
    correctResponse: (q) => ({
      gaps: Object.fromEntries(
        rightChoices(q).flatMap((c, i) => (c ? [[String(i + 1), c.id]] : [])),
      ),
    }),
    isAnswered: (r) => !!r.gaps && Object.values(r.gaps as Record<string, string>).some((v) => !!v),
    answerText(q, r) {
      const gaps = (r.gaps as Record<string, string>) ?? {};
      if (!Object.values(gaps).some(Boolean)) return '';
      const byId = new Map(choicesOf(q).map((c) => [c.id, c.text]));
      let k = 0;
      return plain(
        (q.text ?? '').replace(GAP, () => `[${byId.get(gaps[String(++k)] ?? '') ?? '—'}]`),
      );
    },
    publicView(q) {
      const list = choicesOf(q);
      const byId = new Map(list.map((c) => [c.id, c]));
      return {
        gapPlaces: rightChoices(q).map((c, i) => ({ place: i + 1, group: c?.group ?? 1 })),
        gapChoices: (q.choices ?? list.map((c) => c.id))
          .map((id) => byId.get(id))
          .filter((c) => !!c)
          .map((c) => ({
            id: c.id,
            text: c.text,
            group: c.group,
            ...(type === 'DDWTOS' ? { infinite: !!c.infinite } : {}),
          })),
        gapDrag: type === 'DDWTOS',
      };
    },
    publicText: (_q, text) => placeGaps(text),
    checkText(text, data) {
      const numbers = gapNumbers(text);
      if (!numbers.length) return problem('errors.questions.needsGap', { example: '[[1]]' });
      const missing = numbers.filter((n) => n < 1 || n > data.choices.length);
      if (missing.length)
        return problem('errors.questions.noChoiceFor', {
          gaps: [...new Set(missing)].map((n) => `[[${n}]]`).join(', '),
        });
      if (type === 'DDWTOS') {
        const list = data.choices as Choice[];
        const twice = numbers.filter((n, i) => numbers.indexOf(n) !== i && !list[n - 1]?.infinite);
        if (twice.length) return problem('errors.questions.choiceTwice', { n: twice[0]! });
      }
      return null;
    },
    parts(q, r) {
      const right = rightGaps(q, r.gaps);
      return { right: right.filter(Boolean).length, total: right.length };
    },
    countback: (q, responses, penalty) =>
      countbackByParts(
        responses.map((r) => rightGaps(q, r.gaps)),
        penalty,
      ),
    clearWrong(q, r) {
      const right = rightGaps(q, r.gaps);
      return {
        gaps: Object.fromEntries(
          Object.entries(r.gaps).filter(([place]) => right[Number(place) - 1]),
        ),
      };
    },
  };
  return def as unknown as QuestionTypeDef<T>;
}

export const gapselect = makeGapType('GAPSELECT');
export const ddwtos = makeGapType('DDWTOS');
