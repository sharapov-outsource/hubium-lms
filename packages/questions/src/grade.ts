import { shuffle, subSeed } from './random.ts';
import {
  type QuestionData,
  type QuestionResponse,
  type QuestionSnapshot,
  type QuestionType,
  ResponseSchemas,
} from './types.ts';

export interface GradeResult {
  /** 0..1, or null when a human must grade it (essay) or there is nothing to grade. */
  fraction: number | null;
  needsGrading: boolean;
  /** Per-answer feedback shown in review. */
  feedback: string[];
}

function normaliseText(s: string, caseSensitive: boolean): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return caseSensitive ? t : t.toLocaleLowerCase('ru');
}

/** Moodle-style wildcard match: "*" matches any sequence. */
function wildcardMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'u',
  );
  return re.test(value);
}

export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function gradeResponse(
  q: Pick<QuestionSnapshot, 'type' | 'data'>,
  raw: unknown,
): GradeResult {
  const type = q.type;
  const parsed = ResponseSchemas[type].safeParse(raw ?? {});
  const empty: GradeResult = { fraction: 0, needsGrading: false, feedback: [] };
  if (!parsed.success) return empty;
  const r = parsed.data as QuestionResponse;
  switch (type) {
    case 'MULTICHOICE': {
      const d = q.data as QuestionData<'MULTICHOICE'>;
      const selected = new Set((r as { selected: string[] }).selected);
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
    }
    case 'TRUEFALSE': {
      const d = q.data as QuestionData<'TRUEFALSE'>;
      const v = (r as { value: boolean | null }).value;
      if (v === null) return empty;
      const fb = v ? d.feedbackTrue : d.feedbackFalse;
      return { fraction: v === d.correct ? 1 : 0, needsGrading: false, feedback: fb ? [fb] : [] };
    }
    case 'SHORTANSWER': {
      const d = q.data as QuestionData<'SHORTANSWER'>;
      const given = normaliseText((r as { text: string }).text, d.caseSensitive);
      if (!given) return empty;
      const best = d.answers
        .filter((a) => wildcardMatch(normaliseText(a.text, d.caseSensitive), given))
        .sort((a, b) => b.fraction - a.fraction)[0];
      return {
        fraction: best?.fraction ?? 0,
        needsGrading: false,
        feedback: best?.feedback ? [best.feedback] : [],
      };
    }
    case 'NUMERICAL': {
      const d = q.data as QuestionData<'NUMERICAL'>;
      const n = parseNumber((r as { text: string }).text);
      if (n === null) return empty;
      const best = d.answers
        .filter((a) => Math.abs(n - a.value) <= a.tolerance + 1e-12)
        .sort((a, b) => b.fraction - a.fraction)[0];
      return {
        fraction: best?.fraction ?? 0,
        needsGrading: false,
        feedback: best?.feedback ? [best.feedback] : [],
      };
    }
    case 'MATCH': {
      const d = q.data as QuestionData<'MATCH'>;
      const choices = (r as { choices: Record<string, string> }).choices;
      const right = d.pairs.filter((p) => choices[p.id] === p.answer).length;
      return { fraction: right / d.pairs.length, needsGrading: false, feedback: [] };
    }
    case 'ESSAY': {
      const text = (r as { text: string }).text.trim();
      return { fraction: null, needsGrading: text.length > 0, feedback: [] };
    }
    case 'DESCRIPTION':
      return { fraction: null, needsGrading: false, feedback: [] };
  }
}

/** Fixes per-attempt presentation (answer order, match choices) using a seed. */
export function presentQuestion(
  q: Omit<QuestionSnapshot, 'order' | 'choices'>,
  seed: number,
  shuffleAnswers: boolean,
): QuestionSnapshot {
  const s = subSeed(seed, q.id.length + q.id.charCodeAt(0));
  if (q.type === 'MULTICHOICE') {
    const d = q.data as QuestionData<'MULTICHOICE'>;
    const ids = d.answers.map((a) => a.id);
    return { ...q, order: shuffleAnswers && d.shuffleAnswers ? shuffle(ids, s) : ids };
  }
  if (q.type === 'MATCH') {
    const d = q.data as QuestionData<'MATCH'>;
    const choices = [...new Set([...d.pairs.map((p) => p.answer), ...d.distractors])];
    const ids = d.pairs.map((p) => p.id);
    return {
      ...q,
      order: d.shuffle ? shuffle(ids, s) : ids,
      choices: shuffle(choices, subSeed(s, 7)),
    };
  }
  return { ...q };
}

/** A response that would earn full marks (used in review and previews). */
export function correctResponse(
  q: Pick<QuestionSnapshot, 'type' | 'data'>,
): QuestionResponse | null {
  switch (q.type as QuestionType) {
    case 'MULTICHOICE': {
      const d = q.data as QuestionData<'MULTICHOICE'>;
      return {
        selected: d.single
          ? [[...d.answers].sort((a, b) => b.fraction - a.fraction)[0]!.id]
          : d.answers.filter((a) => a.fraction > 0).map((a) => a.id),
      };
    }
    case 'TRUEFALSE':
      return { value: (q.data as QuestionData<'TRUEFALSE'>).correct };
    case 'SHORTANSWER':
      return {
        text: [...(q.data as QuestionData<'SHORTANSWER'>).answers].sort(
          (a, b) => b.fraction - a.fraction,
        )[0]!.text,
      };
    case 'NUMERICAL':
      return {
        text: String(
          [...(q.data as QuestionData<'NUMERICAL'>).answers].sort(
            (a, b) => b.fraction - a.fraction,
          )[0]!.value,
        ),
      };
    case 'MATCH':
      return {
        choices: Object.fromEntries(
          (q.data as QuestionData<'MATCH'>).pairs.map((p) => [p.id, p.answer]),
        ),
      };
    default:
      return null;
  }
}

export function isAnswered(type: QuestionType, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  switch (type) {
    case 'MULTICHOICE':
      return Array.isArray(r.selected) && r.selected.length > 0;
    case 'TRUEFALSE':
      return typeof r.value === 'boolean';
    case 'SHORTANSWER':
    case 'NUMERICAL':
    case 'ESSAY':
      return typeof r.text === 'string' && r.text.trim() !== '';
    case 'MATCH':
      return !!r.choices && Object.values(r.choices as object).some((v) => v);
    default:
      return true;
  }
}
