import type { QuestionData, QuestionSnapshot, QuestionType } from '@hubium/questions';

/** What the browser may see during an attempt: no fractions, no correct answers. */
export interface PublicQuestion {
  slot: number;
  page: number;
  type: QuestionType;
  text: string;
  maxMark: number;
  options?: { id: string; text: string }[];
  multiple?: boolean;
  matchRows?: { id: string; text: string }[];
  matchChoices?: string[];
  minWords?: number;
  maxWords?: number;
  response: unknown;
  flagged: boolean;
}

export function toPublicQuestion(qa: {
  slot: number;
  page: number;
  snapshot: unknown;
  maxMark: unknown;
  response: unknown;
  flagged: boolean;
}): PublicQuestion {
  const s = qa.snapshot as QuestionSnapshot;
  const base = {
    slot: qa.slot,
    page: qa.page,
    type: s.type,
    text: s.text,
    maxMark: Number(qa.maxMark),
    response: qa.response,
    flagged: qa.flagged,
  };
  switch (s.type) {
    case 'MULTICHOICE': {
      const d = s.data as QuestionData<'MULTICHOICE'>;
      const order = s.order ?? d.answers.map((a) => a.id);
      return {
        ...base,
        multiple: !d.single,
        options: order
          .map((id) => d.answers.find((a) => a.id === id)!)
          .filter(Boolean)
          .map((a) => ({ id: a.id, text: a.text })),
      };
    }
    case 'MATCH': {
      const d = s.data as QuestionData<'MATCH'>;
      const order = s.order ?? d.pairs.map((p) => p.id);
      return {
        ...base,
        matchRows: order
          .map((id) => d.pairs.find((p) => p.id === id)!)
          .filter(Boolean)
          .map((p) => ({ id: p.id, text: p.question })),
        matchChoices: s.choices ?? d.pairs.map((p) => p.answer),
      };
    }
    case 'ESSAY': {
      const d = s.data as QuestionData<'ESSAY'>;
      return { ...base, minWords: d.minWords, maxWords: d.maxWords };
    }
    default:
      return base;
  }
}
