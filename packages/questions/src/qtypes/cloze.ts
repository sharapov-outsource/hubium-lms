import { problem } from '../problem.ts';
import { shuffle, subSeed } from '../random.ts';
import type { GradeResult, QuestionTypeDef, QuestionView } from '../registry.ts';
import type { ClozePart } from '../types.ts';
import { multichoice } from './multichoice.ts';
import { numerical } from './numerical.ts';
import { shortanswer } from './shortanswer.ts';

// Embedded answers (Cloze), as Moodle's: gaps written in the question text as
//   {weight:TYPE:=right#feedback~%50%half right~wrong#feedback}
// TYPE: SHORTANSWER (SA, MW), SHORTANSWER_C (SAC, MWC), NUMERICAL (NM, answer:tolerance),
// MULTICHOICE (MC: a list, MCV vertical, MCH horizontal; with S shuffled: MCS, MCVS, MCHS)
// and MULTIRESPONSE (MR, MRH; MRS, MRHS). `\}`, `\#`, `\~` and `\\` escape the
// characters. The text keeps the gaps (it is the source); the data is read from it.

const START =
  /\{(\d*):(NUMERICAL|NM|MULTICHOICE_VS|MCVS|MULTICHOICE_HS|MCHS|MULTICHOICE_V|MCV|MULTICHOICE_H|MCH|MULTICHOICE_S|MCS|MULTICHOICE|MC|SHORTANSWER_C|SAC|MWC|SHORTANSWER|SA|MW|MULTIRESPONSE_HS|MRHS|MULTIRESPONSE_H|MRH|MULTIRESPONSE_S|MRS|MULTIRESPONSE|MR):/g;

type Kind = ClozePart['kind'];
const CODES: Record<
  string,
  { kind: Kind; caseSensitive?: boolean; display?: string; shuffle?: boolean }
> = {
  SHORTANSWER: { kind: 'shortanswer' },
  SA: { kind: 'shortanswer' },
  MW: { kind: 'shortanswer' },
  SHORTANSWER_C: { kind: 'shortanswer', caseSensitive: true },
  SAC: { kind: 'shortanswer', caseSensitive: true },
  MWC: { kind: 'shortanswer', caseSensitive: true },
  NUMERICAL: { kind: 'numerical' },
  NM: { kind: 'numerical' },
  MULTICHOICE: { kind: 'multichoice', display: 'dropdown' },
  MC: { kind: 'multichoice', display: 'dropdown' },
  MULTICHOICE_S: { kind: 'multichoice', display: 'dropdown', shuffle: true },
  MCS: { kind: 'multichoice', display: 'dropdown', shuffle: true },
  MULTICHOICE_V: { kind: 'multichoice', display: 'vertical' },
  MCV: { kind: 'multichoice', display: 'vertical' },
  MULTICHOICE_VS: { kind: 'multichoice', display: 'vertical', shuffle: true },
  MCVS: { kind: 'multichoice', display: 'vertical', shuffle: true },
  MULTICHOICE_H: { kind: 'multichoice', display: 'horizontal' },
  MCH: { kind: 'multichoice', display: 'horizontal' },
  MULTICHOICE_HS: { kind: 'multichoice', display: 'horizontal', shuffle: true },
  MCHS: { kind: 'multichoice', display: 'horizontal', shuffle: true },
  MULTIRESPONSE: { kind: 'multiresponse', display: 'vertical' },
  MR: { kind: 'multiresponse', display: 'vertical' },
  MULTIRESPONSE_S: { kind: 'multiresponse', display: 'vertical', shuffle: true },
  MRS: { kind: 'multiresponse', display: 'vertical', shuffle: true },
  MULTIRESPONSE_H: { kind: 'multiresponse', display: 'horizontal' },
  MRH: { kind: 'multiresponse', display: 'horizontal' },
  MULTIRESPONSE_HS: { kind: 'multiresponse', display: 'horizontal', shuffle: true },
  MRHS: { kind: 'multiresponse', display: 'horizontal', shuffle: true },
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : (ENTITIES[e.toLowerCase()] ?? m),
  );
const unescapeCloze = (s: string) => s.replace(/\\([}#~\\/"])/g, '$1');
/** An answer as plain text: no tags, entities decoded, escapes undone. */
const clean = (s: string) =>
  decode(unescapeCloze(s).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

/** Splits at `sep` where it is not escaped (nor, for #, part of an entity like &#39;). */
function splitAt(s: string, sep: string, once = false): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === sep && !(sep === '#' && s[i - 1] === '&')) {
      out.push(s.slice(from, i));
      from = i + 1;
      if (once) break;
    }
  }
  out.push(s.slice(from));
  return out;
}

const NUMBER =
  /^(-?(?:\d+[.,]?\d*|[.,]\d+)(?:[eE][-+]?\d+)?)(?::(-?(?:\d+[.,]?\d*|[.,]\d+)(?:[eE][-+]?\d+)?))?$/;
const num = (s: string) => Number(s.replace(',', '.'));

export type ClozeError = 'noAnswers' | 'noRight' | 'noNumber';
export interface ClozeBlock {
  /** Where the gap is in the text. */
  start: number;
  end: number;
  part: ClozePart | null;
  /** What is wrong with the gap, for the editor to say in its language. */
  code: ClozeError | null;
}

function readPart(weightText: string, code: string, body: string): ClozePart | ClozeError {
  const spec = CODES[code]!;
  const weight = weightText === '' ? 1 : Number(weightText);
  const alts = splitAt(body, '~').map((alt) => {
    let fraction = 0;
    let specific = false;
    let rest = alt;
    const pct = /^%(-?\d+(?:[.,]\d*)?)%/.exec(rest);
    if (rest.startsWith('=')) {
      fraction = 1;
      rest = rest.slice(1);
    } else if (pct) {
      fraction = num(pct[1]!) / 100;
      specific = true;
      rest = rest.slice(pct[0].length);
    }
    const [answer = '', feedback = ''] = splitAt(rest, '#', true);
    return {
      raw: answer,
      text: clean(answer),
      fraction,
      specific,
      feedback: unescapeCloze(feedback).trim(),
    };
  });
  const given = alts.filter((a) => a.text);
  if (!given.length) return 'noAnswers';
  if (!given.some((a) => a.fraction > 0)) return 'noRight';
  const clamp = (f: number) => Math.min(1, Math.max(-1, f));
  switch (spec.kind) {
    case 'shortanswer':
      return {
        kind: 'shortanswer',
        weight,
        caseSensitive: !!spec.caseSensitive,
        answers: given.map((a) => ({
          text: a.text,
          fraction: Math.max(0, clamp(a.fraction)),
          feedback: a.feedback,
        })),
      };
    case 'numerical': {
      const answers = given.flatMap((a) => {
        const m = NUMBER.exec(a.text.replace(/\s/g, ''));
        return m
          ? [
              {
                value: num(m[1]!),
                tolerance: m[2] ? Math.abs(num(m[2])) : 0,
                fraction: Math.max(0, clamp(a.fraction)),
                feedback: a.feedback,
              },
            ]
          : [];
      });
      if (!answers.some((a) => a.fraction > 0)) return 'noNumber';
      return { kind: 'numerical', weight, answers };
    }
    case 'multichoice':
    case 'multiresponse': {
      let fractions = given.map((a) => clamp(a.fraction));
      if (spec.kind === 'multiresponse') {
        // as Moodle: right answers share the mark; without explicit fractions each wrong
        // answer cancels one right one
        const total = fractions.filter((f) => f > 0).reduce((s, f) => s + f, 0);
        const specific = given.some((a) => a.specific);
        fractions = fractions.map((f) => (f > 0 ? f / total : specific ? f : -1 / total));
      }
      const answers = given.map((a, i) => ({
        id: `a${i + 1}`,
        text: a.text,
        fraction: fractions[i]!,
        feedback: a.feedback,
      }));
      return spec.kind === 'multichoice'
        ? {
            kind: 'multichoice',
            weight,
            display: spec.display as 'dropdown',
            shuffle: !!spec.shuffle,
            answers,
          }
        : {
            kind: 'multiresponse',
            weight,
            display: spec.display as 'vertical',
            shuffle: !!spec.shuffle,
            answers,
          };
    }
  }
}

/** The gaps of a Cloze text, in order, each read or with what is wrong with it. */
export function scanCloze(text: string): ClozeBlock[] {
  const start = new RegExp(START.source, 'g');
  const out: ClozeBlock[] = [];
  for (let m = start.exec(text); m; m = start.exec(text)) {
    let end = -1;
    for (let i = start.lastIndex; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '}') {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    const read = readPart(m[1]!, m[2]!, text.slice(start.lastIndex, end));
    const bad = typeof read === 'string';
    out.push({
      start: m.index,
      end: end + 1,
      part: bad ? null : read,
      code: bad ? read : null,
    });
    start.lastIndex = end + 1;
  }
  return out;
}

const CODE_OF = (p: ClozePart): string => {
  const s = 'shuffle' in p && p.shuffle ? 'S' : '';
  switch (p.kind) {
    case 'shortanswer':
      return p.caseSensitive ? 'SAC' : 'SA';
    case 'numerical':
      return 'NM';
    case 'multichoice':
      return p.display === 'vertical'
        ? `MCV${s}`
        : p.display === 'horizontal'
          ? `MCH${s}`
          : `MC${s}`;
    case 'multiresponse':
      return p.display === 'horizontal' ? `MRH${s}` : `MR${s}`;
  }
};
const escapeCloze = (s: string) => s.replace(/[\\}#~]/g, (c) => `\\${c}`);

/** A gap written back as Cloze, `{1:SA:=Paris#Right~%50%paris}`. */
export function toClozeSource(p: ClozePart): string {
  const fraction = (f: number) => (f === 1 ? '=' : f ? `%${Math.round(f * 1e5) / 1e3}%` : '');
  const fb = (f: string) => (f ? `#${escapeCloze(f)}` : '');
  const answers =
    p.kind === 'numerical'
      ? p.answers.map(
          (a) =>
            `${fraction(a.fraction)}${a.value}${a.tolerance ? `:${a.tolerance}` : ''}${fb(a.feedback)}`,
        )
      : p.answers.map((a) => `${fraction(a.fraction)}${escapeCloze(a.text)}${fb(a.feedback)}`);
  return `{${p.weight}:${CODE_OF(p)}:${answers.join('~')}}`;
}

// ── grading, through the plain types ─────────────────────────────────────────────

type Value = string | string[] | undefined;

const isGiven = (v: Value) => (Array.isArray(v) ? v.length > 0 : !!v && v.trim() !== '');

function gradePart(p: ClozePart, v: Value): GradeResult {
  const text = typeof v === 'string' ? v : '';
  switch (p.kind) {
    case 'shortanswer':
      return shortanswer.grade(
        { type: 'SHORTANSWER', data: { caseSensitive: p.caseSensitive, answers: p.answers } },
        { text },
      );
    case 'numerical':
      return numerical.grade({ type: 'NUMERICAL', data: { answers: p.answers } }, { text });
    case 'multichoice':
    case 'multiresponse':
      return multichoice.grade(
        {
          type: 'MULTICHOICE',
          data: { single: p.kind === 'multichoice', shuffleAnswers: false, answers: p.answers },
        },
        { selected: Array.isArray(v) ? v : text ? [text] : [] },
      );
  }
}

const partFraction = (p: ClozePart, v: Value) => (isGiven(v) ? (gradePart(p, v).fraction ?? 0) : 0);

function rightValue(p: ClozePart): Value {
  switch (p.kind) {
    case 'shortanswer':
      return [...p.answers].sort((a, b) => b.fraction - a.fraction)[0]!.text;
    case 'numerical':
      return String([...p.answers].sort((a, b) => b.fraction - a.fraction)[0]!.value);
    case 'multichoice':
      return [...p.answers].sort((a, b) => b.fraction - a.fraction)[0]!.id;
    case 'multiresponse':
      return p.answers.filter((a) => a.fraction > 0).map((a) => a.id);
  }
}

function valueText(p: ClozePart, v: Value): string {
  if (!isGiven(v)) return '—';
  if (p.kind === 'shortanswer' || p.kind === 'numerical') return String(v);
  const ids = Array.isArray(v) ? v : [v!];
  return ids.map((id) => p.answers.find((a) => a.id === id)?.text ?? '?').join(', ');
}

type View = QuestionView<'MULTIANSWER'>;
const valueAt = (r: { parts: Record<string, string | string[]> }, k: number): Value =>
  r.parts[String(k + 1)];
const weights = (q: View) => q.data.parts.reduce((s, p) => s + p.weight, 0);

const plain = (html: string) =>
  decode(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** The text with each gap replaced. */
function replaceGaps(text: string, by: (k: number) => string): string {
  let out = '';
  let at = 0;
  for (const [k, b] of scanCloze(text).entries()) {
    out += text.slice(at, b.start) + by(k);
    at = b.end;
  }
  return out + text.slice(at);
}

export const multianswer: QuestionTypeDef<'MULTIANSWER'> = {
  type: 'MULTIANSWER',
  grading: 'auto',
  present(q, seed, shuffleAnswers) {
    if (!shuffleAnswers) return {};
    const order = q.data.parts.flatMap((p, k) =>
      (p.kind === 'multichoice' || p.kind === 'multiresponse') && p.shuffle
        ? shuffle(
            p.answers.map((a) => `${k + 1}:${a.id}`),
            subSeed(seed, k + 1),
          )
        : [],
    );
    return order.length ? { order } : {};
  },
  grade(q, r) {
    const total = weights(q);
    let sum = 0;
    const feedback: string[] = [];
    q.data.parts.forEach((p, k) => {
      const v = valueAt(r, k);
      if (!isGiven(v)) return;
      const g = gradePart(p, v);
      sum += (g.fraction ?? 0) * p.weight;
      feedback.push(...g.feedback);
    });
    return { fraction: total ? sum / total : 0, needsGrading: false, feedback };
  },
  correctResponse: (q) => ({
    parts: Object.fromEntries(q.data.parts.map((p, k) => [String(k + 1), rightValue(p)!])),
  }),
  isAnswered: (r) =>
    !!r.parts && Object.values(r.parts as Record<string, Value>).some((v) => isGiven(v)),
  answerText(q, r) {
    const parts = (r.parts as Record<string, Value>) ?? {};
    if (!Object.values(parts).some((v) => isGiven(v))) return '';
    return plain(
      replaceGaps(q.text ?? '', (k) => {
        const p = q.data.parts[k];
        return p ? `[${valueText(p, parts[String(k + 1)])}]` : '[?]';
      }),
    );
  },
  publicView(q) {
    return {
      clozeParts: q.data.parts.map((p, k) => {
        const base = { place: k + 1, kind: p.kind };
        if (p.kind === 'shortanswer' || p.kind === 'numerical') {
          const longest = Math.max(
            ...p.answers.map((a) => ('text' in a ? a.text : String(a.value)).length),
          );
          return { ...base, size: Math.min(30, Math.max(6, longest + 2)) };
        }
        const shown = (q.order ?? [])
          .filter((x) => x.startsWith(`${k + 1}:`))
          .map((x) => x.slice(String(k + 1).length + 1));
        const ids = shown.length ? shown : p.answers.map((a) => a.id);
        return {
          ...base,
          display: p.display,
          options: ids.flatMap((id) => {
            const a = p.answers.find((x) => x.id === id);
            return a ? [{ id: a.id, text: a.text }] : [];
          }),
        };
      }),
    };
  },
  publicText: (_q, text) => replaceGaps(text, (k) => `[[${k + 1}]]`),
  checkText(text, data) {
    const blocks = scanCloze(text);
    if (!blocks.length)
      return problem('errors.questions.needsGap', { example: '{1:SHORTANSWER:=answer}' });
    const bad = blocks.findIndex((b) => b.code);
    if (bad >= 0) return problem(`errors.questions.gap.${blocks[bad]!.code}`, { n: bad + 1 });
    if (blocks.length !== data.parts.length) return problem('errors.questions.gapsMismatch');
    return null;
  },
  deriveData: (text) => ({
    parts: scanCloze(text).flatMap((b) => (b.part ? [b.part] : [])),
  }),
  parts(q, r) {
    const right = q.data.parts.filter((p, k) => partFraction(p, valueAt(r, k)) >= 1 - 1e-9);
    return { right: right.length, total: q.data.parts.length };
  },
  clearWrong: (q, r) => ({
    parts: Object.fromEntries(
      Object.entries(r.parts).filter(([k, v]) => {
        const p = q.data.parts[Number(k) - 1];
        return p && partFraction(p, v) >= 1 - 1e-9;
      }),
    ),
  }),
  // as Moodle: a gap scores its last answer less the penalty for each try before the
  // one where that answer was given
  countback(q, responses, penalty) {
    const total = weights(q);
    if (!total) return 0;
    let sum = 0;
    q.data.parts.forEach((p, k) => {
      // as Moodle, the empty answer it starts from does not count as a change
      let last = '""';
      let changed = 0;
      let fraction = 0;
      responses.forEach((r, i) => {
        const v = valueAt(r, k);
        const key = JSON.stringify(isGiven(v) ? v : '');
        if (key === last) return;
        last = key;
        changed = i;
        fraction = partFraction(p, v);
      });
      sum += p.weight * Math.max(0, fraction - changed * penalty);
    });
    return sum / total;
  },
};
