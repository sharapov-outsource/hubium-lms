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

type Gradable = Pick<QuestionSnapshot, 'type' | 'data' | 'order' | 'choices'>;

export function gradeResponse(q: Gradable, raw: unknown): GradeResult {
  const parsed = ResponseSchemas[q.type].safeParse(raw ?? {});
  if (!parsed.success) return { fraction: 0, needsGrading: false, feedback: [] };
  return typeDef(q.type).grade(q as QuestionView, parsed.data as never);
}

/** Fixes per-attempt presentation (answer order, match choices) using a seed. */
export function presentQuestion(
  q: Omit<QuestionSnapshot, 'order' | 'choices'>,
  seed: number,
  shuffleAnswers: boolean,
): QuestionSnapshot {
  const s = subSeed(seed, q.id.length + q.id.charCodeAt(0));
  return { ...q, ...(typeDef(q.type).present?.(q as QuestionView, s, shuffleAnswers) ?? {}) };
}

/** A response that would earn full marks (used in review and previews). */
export function correctResponse(q: Gradable): QuestionResponse | null {
  return typeDef(q.type).correctResponse(q as QuestionView) as QuestionResponse | null;
}

export function isAnswered(type: QuestionType, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return typeDef(type).isAnswered(raw as Record<string, unknown>);
}

/** The response as text for review screens (choices by their text, matches as pairs). */
export function answerText(q: Gradable, raw: unknown): string {
  return typeDef(q.type).answerText(q as QuestionView, (raw ?? {}) as Record<string, unknown>);
}
