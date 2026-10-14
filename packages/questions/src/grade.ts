import { typeDef } from './qtypes/index.ts';
import { subSeed } from './random.ts';
import type { GradeResult, QuestionView } from './registry.ts';
import {
  type QuestionResponse,
  type QuestionSnapshot,
  type QuestionType,
  ResponseSchemas,
} from './types.ts';

// Entry points over the type definitions (qtypes/*), kept for their callers.

export { parseNumber } from './qtypes/text.ts';
export type { GradeResult } from './registry.ts';

type Gradable = Pick<QuestionSnapshot, 'type' | 'data' | 'order' | 'choices' | 'vars'> & {
  /** Types with gaps in the text need it. */
  text?: string;
};

export function gradeResponse(q: Gradable, raw: unknown): GradeResult {
  // no response at all scores 0, as it always has (a blank one is graded as given)
  if (raw === null || raw === undefined) return { fraction: 0, needsGrading: false, feedback: [] };
  const parsed = ResponseSchemas[q.type].safeParse(raw);
  if (!parsed.success) return { fraction: 0, needsGrading: false, feedback: [] };
  return typeDef(q.type).grade(q as QuestionView, parsed.data as never);
}

/** Fixes per-attempt presentation (answer order, match choices) using a seed. */
export function presentQuestion(
  q: Omit<QuestionSnapshot, 'order' | 'choices'>,
  seed: number,
  shuffleAnswers: boolean,
  opts?: { syncSeed?: number },
): QuestionSnapshot {
  const s = subSeed(seed, q.id.length + q.id.charCodeAt(0));
  return {
    ...q,
    ...(typeDef(q.type).present?.(q as QuestionView, s, shuffleAnswers, opts) ?? {}),
  };
}

/** A text around the question (general feedback, a hint) with the attempt's values in. */
export function fillText(q: Gradable, html: string): string {
  return typeDef(q.type).fillText?.(q as QuestionView, html) ?? html;
}

/** A response that would earn full marks (used in review and previews). */
export function correctResponse(q: Gradable): QuestionResponse | null {
  return typeDef(q.type).correctResponse(q as QuestionView) as QuestionResponse | null;
}

export function isAnswered(type: QuestionType, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return typeDef(type).isAnswered(raw as Record<string, unknown>);
}

/** The question text as the learner sees it. */
export function publicText(q: Gradable & { text: string }): string {
  return typeDef(q.type).publicText?.(q as QuestionView, q.text) ?? q.text;
}

/** The data of a question: as given, or read from its text for types written there (Cloze). */
export function questionDataFrom(type: QuestionType, text: string, data: unknown): unknown {
  return typeDef(type).deriveData?.(text) ?? data;
}

/** What is wrong with a question's text for its type, or null. */
export function checkQuestionText(type: QuestionType, text: string, data: unknown): string | null {
  return typeDef(type).checkText?.(text, data as never) ?? null;
}

/** Per-part scores for review (an ordering's items), or null. */
export function reviewParts(q: Gradable, raw: unknown) {
  const def = typeDef(q.type);
  const parsed = ResponseSchemas[q.type].safeParse(raw ?? {});
  if (!def.reviewParts || !parsed.success) return null;
  return def.reviewParts(q as QuestionView, parsed.data as never);
}

/** The response as text for review screens (choices by their text, matches as pairs). */
export function answerText(q: Gradable, raw: unknown): string {
  return typeDef(q.type).answerText(q as QuestionView, (raw ?? {}) as Record<string, unknown>);
}
