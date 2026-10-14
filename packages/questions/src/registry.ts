import { z } from 'zod';
import type { QuestionData, QuestionSnapshot, QuestionType, ResponseSchemas } from './types.ts';

// One definition per question type: grading, presentation, review text, the public view an
// attempt shows and GIFT export live together, so a new type is one file (qtypes/*) plus
// its entry in `questionTypeDefs` (qtypes/index.ts), which TypeScript keeps complete.

export interface GradeResult {
  /** 0..1, or null when a human must grade it (essay) or there is nothing to grade. */
  fraction: number | null;
  needsGrading: boolean;
  /** Per-answer feedback shown in review. */
  feedback: string[];
}

export type ResponseOf<T extends QuestionType> = z.output<(typeof ResponseSchemas)[T]>;

/** What a definition sees of a question: its data plus the attempt's presentation. */
export interface QuestionView<T extends QuestionType = QuestionType> {
  type: T;
  data: QuestionData<T>;
  /** The question text: types with gaps in it read them from here. */
  text?: string;
  order?: string[];
  choices?: string[];
}

/**
 * Type-specific fields of a question in an attempt. Only what the learner needs to answer:
 * never fractions, correct answers or feedback (a test checks this for every type).
 */
export const PublicFields = z.object({
  options: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  multiple: z.boolean().optional(),
  matchRows: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  matchChoices: z.array(z.string()).optional(),
  minWords: z.number().optional(),
  maxWords: z.number().optional(),
  orderItems: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  orderLayout: z.enum(['vertical', 'horizontal']).optional(),
  orderNumbering: z.string().optional(),
  /** The gaps of the text: [[1]], [[2]], … in order, each taking choices of its group. */
  gapPlaces: z.array(z.object({ place: z.number(), group: z.number() })).optional(),
  gapChoices: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        group: z.number(),
        infinite: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Answered by dragging choices into the gaps (or picking them) rather than from lists. */
  gapDrag: z.boolean().optional(),
});
export type PublicFields = z.output<typeof PublicFields>;

export interface GiftParts {
  /** "::name:: text" */
  head: string;
  /** " ####general feedback", or '' */
  gf: string;
  /** " #feedback", or '' */
  fb: (feedback: string) => string;
  esc: (s: string) => string;
}

export interface QuestionTypeDef<T extends QuestionType> {
  type: T;
  /** auto: the computer grades it; manual: a teacher does (essay); none: not graded. */
  grading: 'auto' | 'manual' | 'none';
  /** Response fields holding rich text: sanitised before they are stored. */
  richText?: readonly string[];
  /** Per-attempt presentation fixed by a seed (answer order, choices). */
  present?(q: QuestionView<T>, seed: number, shuffleAnswers: boolean): Partial<QuestionSnapshot>;
  grade(q: QuestionView<T>, r: ResponseOf<T>): GradeResult;
  /** A response earning full marks, or null when there is none (essay, description). */
  correctResponse(q: QuestionView<T>): ResponseOf<T> | null;
  /** Pure, so the attempt player in the browser uses it too. */
  isAnswered(r: Record<string, unknown>): boolean;
  /** The response as text for review screens. */
  answerText(q: QuestionView<T>, r: Record<string, unknown>): string;
  publicView(q: QuestionView<T>): PublicFields;
  /**
   * The question text as the learner sees it, when the type marks it up (gaps renumbered
   * so they do not tell the right choice).
   */
  publicText?(q: QuestionView<T>, text: string): string;
  /** What is wrong with the question text for this type's data, or null. */
  checkText?(text: string, data: QuestionData<T>): string | null;
  /** Per-part scores shown in review (an ordering's items), when the question shows them. */
  reviewParts?(
    q: QuestionView<T>,
    r: ResponseOf<T>,
  ): { text: string; fraction: number | null }[] | null;
  /** The whole GIFT question; absent when GIFT cannot express the type. */
  gift?(data: QuestionData<T>, p: GiftParts): string;
  /** Right parts of a response, for the hint "show the number of correct responses". */
  parts?(q: QuestionView<T>, r: ResponseOf<T>): { right: number; total: number };
  /**
   * The response without its wrong parts, for the hint "clear incorrect responses". Without
   * it a wrong response is cleared entirely.
   */
  clearWrong?(q: QuestionView<T>, r: ResponseOf<T>): ResponseOf<T>;
  /**
   * Which parts of a response are right. Types with it are graded part by part in the
   * interactive behaviour (Moodle's "countback"): each part loses the penalty for every
   * try it was wrong in, rather than the whole question for every wrong try.
   */
  rightParts?(q: QuestionView<T>, r: ResponseOf<T>): boolean[];
}

export type QuestionTypeDefs = { [K in QuestionType]: QuestionTypeDef<K> };
