import { type Problem, ProblemError, problem } from './problem.ts';
import { typeDef } from './qtypes/index.ts';
import type { QuestionData, QuestionType } from './types.ts';

// GIFT format (Moodle) import/export for the common question types.
// https://docs.moodle.org/en/GIFT_format

export interface ParsedQuestion {
  type: QuestionType;
  name: string;
  text: string;
  generalFeedback: string;
  data: QuestionData;
  category?: string;
}

export interface GiftResult {
  questions: ParsedQuestion[];
  errors: { block: number; problem: Problem }[];
}

const ESC: Record<string, string> = {
  '~': '\u0001',
  '=': '\u0002',
  '#': '\u0003',
  '{': '\u0004',
  '}': '\u0005',
  ':': '\u0006',
};
const UNESC = Object.fromEntries(Object.entries(ESC).map(([k, v]) => [v, k]));

function protect(s: string): string {
  return s.replace(/\\([~=#{}:])/g, (_, c: string) => ESC[c]!).replace(/\\n/g, '\n');
}
function restore(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholders for escaped GIFT chars
  return s.replace(/[\u0001-\u0006]/g, (c) => UNESC[c]!).trim();
}

function splitAnswers(body: string): { mark: '=' | '~'; text: string }[] {
  const out: { mark: '=' | '~'; text: string }[] = [];
  const re = /([=~])([^=~]*)/g;
  for (const m of body.matchAll(re)) out.push({ mark: m[1] as '=' | '~', text: m[2]! });
  return out;
}

function splitFeedback(s: string): [string, string] {
  const i = s.indexOf('#');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

function parseWeight(s: string): [number | null, string] {
  const m = /^%(-?\d+(?:\.\d+)?)%(.*)$/s.exec(s.trim());
  return m ? [Number(m[1]) / 100, m[2]!] : [null, s];
}

function parseBlock(raw: string, category: string | undefined): ParsedQuestion {
  let s = protect(raw.replace(/^\s*\/\/.*$/gm, '').trim());
  let name = '';
  const title = /^::(.*?)::/s.exec(s);
  if (title) {
    name = restore(title[1]!);
    s = s.slice(title[0].length);
  }
  s = s.replace(/^\[(html|moodle|plain|markdown)\]/, '');
  const open = s.indexOf('{');
  if (open < 0) {
    const text = restore(s);
    return {
      type: 'DESCRIPTION',
      name: name || text.slice(0, 60),
      text,
      generalFeedback: '',
      data: {},
      category,
    };
  }
  const close = s.lastIndexOf('}');
  if (close < open)
    throw new ProblemError(problem('errors.questions.giftUnclosed', { brace: '{' }));
  const textBefore = s.slice(0, open);
  const textAfter = s.slice(close + 1);
  const text = restore(`${textBefore}${textAfter ? ` _____ ${textAfter}` : ''}`);
  let body = s.slice(open + 1, close).trim();
  let generalFeedback = '';
  const gf = /####(.*)$/s.exec(body);
  if (gf) {
    generalFeedback = restore(gf[1]!);
    body = body.slice(0, gf.index).trim();
  }
  const base = { name: name || text.slice(0, 60), text, generalFeedback, category };

  if (body === '')
    return { ...base, type: 'ESSAY', data: { minWords: 0, maxWords: 0, graderInfo: '' } };

  const tf = /^(T|TRUE|F|FALSE)\s*(#[^#]*)?(#[^#]*)?$/i.exec(body);
  if (tf) {
    const correct = /^T/i.test(tf[1]!);
    const fbWrong = tf[2] ? restore(tf[2].slice(1)) : '';
    const fbRight = tf[3] ? restore(tf[3].slice(1)) : '';
    return {
      ...base,
      type: 'TRUEFALSE',
      data: {
        correct,
        feedbackTrue: correct ? fbRight : fbWrong,
        feedbackFalse: correct ? fbWrong : fbRight,
      },
    };
  }

  if (body.startsWith('#')) {
    const parts = body
      .slice(1)
      .split(/(?==)/)
      .map((p) => p.replace(/^=/, '').trim())
      .filter(Boolean);
    const answers = parts.map((p) => {
      const [w, rest] = parseWeight(p);
      const [valuePart, fb] = splitFeedback(rest);
      let value: number;
      let tolerance = 0;
      const range = /^(-?[\d.]+)\.\.(-?[\d.]+)$/.exec(valuePart.trim());
      if (range) {
        const lo = Number(range[1]);
        const hi = Number(range[2]);
        value = (lo + hi) / 2;
        tolerance = (hi - lo) / 2;
      } else {
        const [v, t] = valuePart.split(':');
        value = Number(v);
        tolerance = t ? Number(t) : 0;
      }
      if (Number.isNaN(value) || Number.isNaN(tolerance))
        throw new ProblemError(
          problem('errors.questions.giftNumber', { value: restore(valuePart) }),
        );
      return { value, tolerance, fraction: w ?? 1, feedback: restore(fb) };
    });
    return { ...base, type: 'NUMERICAL', data: { answers } };
  }

  const answers = splitAnswers(body);
  if (!answers.length) throw new ProblemError(problem('errors.questions.giftNoAnswers'));

  if (answers.every((a) => a.mark === '=') && answers.some((a) => a.text.includes('->'))) {
    const pairs = answers.map((a, i) => {
      const [q, ans] = a.text.split('->');
      return { id: `p${i + 1}`, question: restore(q ?? ''), answer: restore(ans ?? '') };
    });
    return {
      ...base,
      type: 'MATCH',
      data: {
        shuffle: true,
        pairs: pairs.filter((p) => p.question),
        distractors: pairs.filter((p) => !p.question).map((p) => p.answer),
      },
    };
  }

  if (answers.every((a) => a.mark === '=')) {
    return {
      ...base,
      type: 'SHORTANSWER',
      data: {
        caseSensitive: false,
        answers: answers.map((a) => {
          const [w, rest] = parseWeight(a.text);
          const [t, fb] = splitFeedback(rest);
          return { text: restore(t), fraction: w ?? 1, feedback: restore(fb) };
        }),
      },
    };
  }

  // As in Moodle: a question with an "=" answer takes one answer (the others may give
  // partial credit); only a question without one takes several.
  const single = answers.some((a) => a.mark === '=');
  const choices = answers.map((a, i) => {
    const [w, rest] = parseWeight(a.text);
    const [t, fb] = splitFeedback(rest);
    return {
      id: `a${i + 1}`,
      text: restore(t),
      fraction: a.mark === '=' ? 1 : (w ?? 0),
      feedback: restore(fb),
    };
  });
  return {
    ...base,
    type: 'MULTICHOICE',
    data: { single, shuffleAnswers: true, answers: choices },
  };
}

export function parseGift(source: string): GiftResult {
  const result: GiftResult = { questions: [], errors: [] };
  let category: string | undefined;
  const blocks = source.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  blocks.forEach((block, i) => {
    const lines = block.split('\n').filter((l) => !/^\s*\/\//.test(l));
    const catLine = lines.find((l) => /^\s*\$CATEGORY:/.test(l));
    if (catLine) {
      category = catLine
        .replace(/^\s*\$CATEGORY:\s*/, '')
        .replace(/^\$(course|system)\$\//, '')
        .trim();
    }
    const text = lines
      .filter((l) => !/^\s*\$CATEGORY:/.test(l))
      .join('\n')
      .trim();
    if (!text) return;
    try {
      result.questions.push(parseBlock(text, category));
    } catch (e) {
      // a block that breaks the parser in a way it does not name is reported, not fatal
      const p = e instanceof ProblemError ? e.problem : problem('errors.questions.giftUnreadable');
      result.errors.push({ block: i + 1, problem: p });
    }
  });
  return result;
}

const esc = (s: string) => s.replace(/([~=#{}:\\])/g, '\\$1').replace(/\n/g, '\\n');

/** The question in GIFT, or null when GIFT cannot express its type. */
export function toGift(q: Omit<ParsedQuestion, 'category'>): string | null {
  const head = `::${esc(q.name)}:: ${esc(q.text)}`;
  const gf = q.generalFeedback ? ` ####${esc(q.generalFeedback)}` : '';
  const fb = (f: string) => (f ? ` #${esc(f)}` : '');
  const def = typeDef(q.type);
  return def.gift ? def.gift(q.data as never, { head, gf, fb, esc }) : null;
}
