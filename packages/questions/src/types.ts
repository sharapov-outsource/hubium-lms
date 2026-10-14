import { z } from 'zod';

// Question type data (stored in Question.data, validated per type) and response shapes.

const Answer = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(5000),
  /** Fraction of the mark for choosing this answer: 1 = fully correct, may be negative. */
  fraction: z.number().min(-1).max(1),
  feedback: z.string().max(5000).default(''),
});

export const MultichoiceData = z
  .object({
    single: z.boolean().default(true),
    shuffleAnswers: z.boolean().default(true),
    answers: z.array(Answer).min(2).max(20),
  })
  .refine((d) => d.answers.some((a) => a.fraction > 0), 'At least one answer must be correct');

export const TrueFalseData = z.object({
  correct: z.boolean(),
  feedbackTrue: z.string().default(''),
  feedbackFalse: z.string().default(''),
});

export const ShortAnswerData = z.object({
  caseSensitive: z.boolean().default(false),
  answers: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        fraction: z.number().min(0).max(1),
        feedback: z.string().default(''),
      }),
    )
    .min(1)
    .max(20),
});

export const NumericalData = z.object({
  answers: z
    .array(
      z.object({
        value: z.number(),
        tolerance: z.number().min(0).default(0),
        fraction: z.number().min(0).max(1),
        feedback: z.string().default(''),
      }),
    )
    .min(1)
    .max(20),
});

export const MatchData = z.object({
  shuffle: z.boolean().default(true),
  pairs: z
    .array(
      z.object({ id: z.string().min(1), question: z.string().min(1), answer: z.string().min(1) }),
    )
    .min(2)
    .max(20),
  /** Extra wrong answers shown in every dropdown. */
  distractors: z.array(z.string()).default([]),
});

export const EssayData = z.object({
  minWords: z.number().int().min(0).default(0),
  maxWords: z.number().int().min(0).default(0),
  graderInfo: z.string().default(''),
});

export const DescriptionData = z.object({});

export const questionDataSchemas = {
  MULTICHOICE: MultichoiceData,
  TRUEFALSE: TrueFalseData,
  SHORTANSWER: ShortAnswerData,
  NUMERICAL: NumericalData,
  MATCH: MatchData,
  ESSAY: EssayData,
  DESCRIPTION: DescriptionData,
} as const;

export type QuestionType = keyof typeof questionDataSchemas;
export const questionTypes = Object.keys(questionDataSchemas) as QuestionType[];

export type QuestionData<T extends QuestionType = QuestionType> = z.output<
  (typeof questionDataSchemas)[T]
>;

/** Shown after an unsuccessful try in interactive mode, one per try. */
export const Hint = z.object({
  text: z.string().max(5000),
  /** Clear the wrong parts of the response before the next try. */
  clearWrong: z.boolean().default(false),
  /** Tell how many parts are right. */
  showNumCorrect: z.boolean().default(false),
});
export type Hint = z.output<typeof Hint>;
export const Hints = z.array(Hint).max(10).default([]);

/** Frozen copy of a question stored with each attempt. */
export interface QuestionSnapshot {
  id: string;
  type: QuestionType;
  name: string;
  text: string;
  generalFeedback: string;
  defaultMark: number;
  data: QuestionData;
  /** Share of the mark lost for each wrong try in interactive mode (0..1). */
  penalty?: number;
  hints?: Hint[];
  /** Per-attempt presentation order (answer ids / pair ids / choice texts). */
  order?: string[];
  choices?: string[];
}

export const ResponseSchemas = {
  MULTICHOICE: z.object({ selected: z.array(z.string()).max(20) }),
  TRUEFALSE: z.object({ value: z.boolean().nullable() }),
  SHORTANSWER: z.object({ text: z.string().max(1000) }),
  NUMERICAL: z.object({ text: z.string().max(100) }),
  MATCH: z.object({ choices: z.record(z.string(), z.string()) }),
  ESSAY: z.object({ text: z.string().max(100_000) }),
  DESCRIPTION: z.object({}),
} as const;

export type QuestionResponse = z.output<(typeof ResponseSchemas)[QuestionType]>;
