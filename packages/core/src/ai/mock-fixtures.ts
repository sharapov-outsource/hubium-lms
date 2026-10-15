import type { MockFixture } from '@hubium/ai';
import type { QuestionDraft } from '@hubium/questions';

// Deterministic answers for the MOCK provider (tests, CI e2e, demo installs). They read the
// same tagged prompt sections a real model gets, so the whole pipeline is exercised.

export interface PromptSource {
  index: number;
  title: string;
  text: string;
}

/** `<source index="1" title="...">text</source>` blocks of a prompt. */
export function parseSources(prompt: string): PromptSource[] {
  const out: PromptSource[] = [];
  for (const m of prompt.matchAll(/<source index="(\d+)" title="([^"]*)">([\s\S]*?)<\/source>/g))
    out.push({ index: Number(m[1]), title: m[2]!, text: m[3]!.trim() });
  return out;
}

export function tagged(prompt: string, tag: string): string | null {
  const m = prompt.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1]!.trim() : null;
}

const sentences = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.split(' ').length >= 4);

const last = (r: Parameters<MockFixture>[0]) => r.messages.at(-1)?.content ?? '';

const quizgen: MockFixture = (r) => {
  const prompt = last(r);
  const spec = JSON.parse(tagged(prompt, 'spec') ?? '{}') as { count?: number; types?: string[] };
  const count = spec.count ?? 3;
  const types = (spec.types?.length ? spec.types : ['MULTICHOICE']) as QuestionDraft['type'][];
  const pool = parseSources(prompt).flatMap((s) =>
    sentences(s.text).map((text) => ({ source: s, text })),
  );
  const questions: QuestionDraft[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    const { source, text } = pool[i % pool.length]!;
    const type = types[i % types.length]!;
    const draft: QuestionDraft = {
      type,
      name: `${source.title}: вопрос ${i + 1}`,
      text: '',
      explanation: `В материале «${source.title}»: ${text}`,
      sourceIndex: source.index,
      options: [],
      trueFalseAnswer: null,
      acceptedAnswers: [],
      numericAnswer: null,
      tolerance: null,
    };
    const words = text.replace(/[.!?]$/, '').split(' ');
    const number = text.match(/-?\d+(?:[.,]\d+)?/);
    if (type === 'TRUEFALSE') {
      draft.text = `Верно ли: ${text}`;
      draft.trueFalseAnswer = true;
    } else if (type === 'SHORTANSWER') {
      const word = words.reduce((a, b) => (b.length > a.length ? b : a), '');
      draft.text = `Вставьте пропущенное слово: ${text.replace(word, '_____')}`;
      draft.acceptedAnswers = [word.replace(/[«»"(),:;]/g, '')];
    } else if (type === 'NUMERICAL' && number) {
      draft.text = `Какое число пропущено: ${text.replace(number[0], '___')}`;
      draft.numericAnswer = Number(number[0].replace(',', '.'));
      draft.tolerance = 0;
    } else {
      draft.type = 'MULTICHOICE';
      draft.text = `Какое утверждение соответствует материалу «${source.title}»?`;
      draft.options = [
        { text, correct: true, feedback: 'Верно' },
        { text: `Это не так: ${words.slice(0, 3).join(' ')}…`, correct: false, feedback: '' },
        { text: 'В материале об этом не говорится', correct: false, feedback: '' },
      ];
    }
    questions.push(draft);
  }
  return { questions };
};

const summary: MockFixture = (r) =>
  parseSources(last(r))
    .map((s) => sentences(s.text).slice(0, 3).join(' '))
    .join('\n');

const grading: MockFixture = (r) => {
  const prompt = last(r);
  const max = Number(tagged(prompt, 'max_grade') ?? 100);
  const submission = tagged(prompt, 'submission') ?? '';
  const words = submission.split(/\s+/).filter(Boolean).length;
  const criteria = (tagged(prompt, 'criteria') ?? '')
    .split('\n')
    .map((c) => c.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean);
  const ratio = Math.min(1, words / 50);
  return {
    suggestedGrade: Math.round(max * ratio * 10) / 10,
    criteria: (criteria.length ? criteria : ['Полнота ответа']).map((name) => ({
      name,
      score: Math.round(ratio * 10) / 10,
      comment: words >= 50 ? 'Раскрыто' : 'Раскрыто частично',
    })),
    feedbackDraft:
      words >= 50
        ? 'Работа выполнена полно, все требования учтены.'
        : `Ответ слишком короткий (${words} сл.), раскройте тему подробнее.`,
    confidence: words ? 0.6 : 0.2,
  };
};

const tutor: MockFixture = (r) => {
  const prompt = last(r);
  const sources = parseSources(r.cacheablePrefix ?? '').concat(parseSources(prompt));
  if (!sources.length)
    return 'Я не знаю: в доступных материалах курса нет ответа на этот вопрос. Спросите преподавателя.';
  const s = sources[0]!;
  return `По материалам курса [${s.index}]: ${sentences(s.text)[0] ?? s.text.slice(0, 200)}`;
};

export const mockFixtures: Record<string, MockFixture> = {
  quizgen,
  'quizgen.summary': summary,
  grading,
  tutor,
};
