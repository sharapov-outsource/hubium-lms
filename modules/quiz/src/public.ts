import {
  type PublicFields,
  type QuestionSnapshot,
  type QuestionType,
  typeDef,
} from '@hubium/questions';

/** What the browser may see during an attempt: no fractions, no correct answers. */
export interface PublicQuestion extends PublicFields {
  slot: number;
  page: number;
  type: QuestionType;
  text: string;
  maxMark: number;
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
  return {
    slot: qa.slot,
    page: qa.page,
    type: s.type,
    text: s.text,
    maxMark: Number(qa.maxMark),
    response: qa.response,
    flagged: qa.flagged,
    ...typeDef(s.type).publicView(s),
  };
}
