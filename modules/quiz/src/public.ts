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

/** A checked question as the learner sees it during the attempt. */
export interface LiveFeedback {
  verdict: 'correct' | 'partial' | 'incorrect';
  /** null unless the quiz shows marks */
  mark: number | null;
  /** Feedback for the answer given. */
  texts: string[];
  /** The hint after a wrong try (interactive). */
  hint: string | null;
  numCorrect: { right: number; total: number } | null;
  /** The right answer, once the question is complete, if the quiz shows it. */
  rightAnswer: string | null;
}

export interface LiveState {
  state: 'TODO' | 'TRYAGAIN' | 'COMPLETE';
  /** A Check button: immediate or interactive, graded automatically, not checked yet. */
  canCheck: boolean;
  /** Interactive: tries left, the current one included. */
  triesLeft: number | null;
  feedback: LiveFeedback | null;
}

/** A question of an attempt in progress: the public question and its live state. */
export type LiveQuestion = PublicQuestion & LiveState;

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
