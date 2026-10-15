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

/** Feedback by how right the whole response is (Moodle's combined feedback). */
const CombinedFeedback = {
  feedbackCorrect: z.string().max(5000).default(''),
  feedbackPartial: z.string().max(5000).default(''),
  feedbackIncorrect: z.string().max(5000).default(''),
};

/** The ways an order is graded, as Moodle's ordering question. */
export const orderingGradings = [
  'allOrNothing',
  'absolutePosition',
  'relativeToCorrect',
  'relativeNextExcludeLast',
  'relativeNextIncludeLast',
  'relativeOnePreviousAndNext',
  'relativeAllPreviousAndNext',
  'longestOrderedSubset',
  'longestContiguousSubset',
] as const;
export type OrderingGrading = (typeof orderingGradings)[number];
export const orderingNumberings = ['none', 'abc', 'ABCD', '123', 'iii', 'IIII'] as const;

export const OrderingData = z.object({
  /** In the right order. */
  items: z
    .array(z.object({ id: z.string().min(1), text: z.string().min(1).max(2000) }))
    .min(2)
    .max(30),
  grading: z.enum(orderingGradings).default('relativeNextExcludeLast'),
  /** all items, or `selectCount` of them: any, or next to each other in the right order */
  select: z.enum(['all', 'random', 'contiguous']).default('all'),
  selectCount: z.number().int().min(2).max(30).default(6),
  layout: z.enum(['vertical', 'horizontal']).default('vertical'),
  numbering: z.enum(orderingNumberings).default('none'),
  /** Review shows how each item scored. */
  showGrading: z.boolean().default(true),
  ...CombinedFeedback,
});

const GapChoice = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(500),
  /** A gap takes the choices of its right choice's group. */
  group: z.number().int().min(1).max(20).default(1),
});

/** Gaps [[n]] in the question text, each answered from a list; n names the right choice. */
export const GapSelectData = z.object({
  shuffle: z.boolean().default(true),
  choices: z.array(GapChoice).min(2).max(60),
  ...CombinedFeedback,
});

const ClozeAnswer = z.object({
  text: z.string().max(2000),
  fraction: z.number().min(-1).max(1),
  feedback: z.string().max(5000).default(''),
});
const weight = z.number().int().min(0).max(100).default(1);

/** One gap of a Cloze question: a short answer, a number, or a choice of one or several. */
export const ClozePart = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shortanswer'),
    weight,
    caseSensitive: z.boolean().default(false),
    answers: z
      .array(ClozeAnswer.extend({ text: z.string().min(1).max(500) }))
      .min(1)
      .max(30),
  }),
  z.object({
    kind: z.literal('numerical'),
    weight,
    answers: z
      .array(
        z.object({
          value: z.number(),
          tolerance: z.number().min(0).default(0),
          fraction: z.number().min(0).max(1),
          feedback: z.string().max(5000).default(''),
        }),
      )
      .min(1)
      .max(30),
  }),
  z.object({
    kind: z.literal('multichoice'),
    weight,
    display: z.enum(['dropdown', 'vertical', 'horizontal']).default('dropdown'),
    shuffle: z.boolean().default(false),
    answers: z
      .array(ClozeAnswer.extend({ id: z.string().min(1) }))
      .min(1)
      .max(30),
  }),
  z.object({
    kind: z.literal('multiresponse'),
    weight,
    display: z.enum(['vertical', 'horizontal']).default('vertical'),
    shuffle: z.boolean().default(false),
    answers: z
      .array(ClozeAnswer.extend({ id: z.string().min(1) }))
      .min(1)
      .max(30),
  }),
]);
export type ClozePart = z.output<typeof ClozePart>;

/** Embedded answers (Cloze): the gaps are written in the question text, Moodle's way. */
export const MultianswerData = z.object({
  parts: z
    .array(ClozePart)
    .min(1)
    .max(50)
    .refine((ps) => ps.some((p) => p.weight > 0), 'At least one gap must carry marks'),
});

/** Values a variable of a calculated question takes, one per variant (Moodle's dataset). */
export const Dataset = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'errors.field.identifier'),
    min: z.number(),
    max: z.number(),
    decimals: z.number().int().min(0).max(10).default(1),
    distribution: z.enum(['uniform', 'loguniform']).default('uniform'),
    items: z.array(z.number()).max(100).default([]),
  })
  .refine((d) => d.max >= d.min, { message: 'errors.common.maxBelowMin', path: ['max'] })
  .refine((d) => d.distribution !== 'loguniform' || d.min > 0, {
    message: 'errors.common.logUniformAboveZero',
    path: ['min'],
  });
export type Dataset = z.output<typeof Dataset>;

/** How an answer is shown: rounded to decimals or to significant figures (Moodle's format). */
const AnswerFormat = {
  format: z.enum(['decimals', 'significant']).default('decimals'),
  length: z.number().int().min(0).max(9).default(2),
};
export const toleranceTypes = ['relative', 'nominal', 'geometric'] as const;

const CalculatedAnswer = z.object({
  /** e.g. {a} + {b}*2 (see @hubium/formula) */
  formula: z.string().trim().min(1).max(2000),
  fraction: z.number().min(0).max(1),
  tolerance: z.number().min(0).default(0.01),
  toleranceType: z.enum(toleranceTypes).default('relative'),
  feedback: z.string().max(5000).default(''),
  ...AnswerFormat,
});

const DatasetFields = {
  /** The question's own datasets. */
  datasets: z.array(Dataset).max(30).default([]),
  /** Variables taking a dataset shared in the question's category instead. */
  shared: z.array(z.string()).max(30).default([]),
  /** With shared datasets: every such question of an attempt draws the same item. */
  synchronize: z.boolean().default(false),
};

/** Calculated: the answer is a formula of variables drawn from datasets, as Moodle's. */
export const CalculatedData = z.object({
  answers: z.array(CalculatedAnswer).min(1).max(20),
  ...DatasetFields,
});

/** Calculated simple: as calculated, with the question's own datasets only. */
export const CalculatedSimpleData = z.object({
  answers: z.array(CalculatedAnswer).min(1).max(20),
  datasets: DatasetFields.datasets,
});

/** Calculated multichoice: choices whose text holds {x} and {=formula}. */
export const CalculatedMultiData = z
  .object({
    single: z.boolean().default(true),
    shuffleAnswers: z.boolean().default(true),
    answers: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1).max(5000),
          fraction: z.number().min(-1).max(1),
          feedback: z.string().max(5000).default(''),
          ...AnswerFormat,
        }),
      )
      .min(2)
      .max(20),
    ...DatasetFields,
  })
  .refine((d) => d.answers.some((a) => a.fraction > 0), 'At least one answer must be correct');

/** As GapSelectData, answered by dragging; an unlimited choice can fill several gaps. */
export const DdwtosData = z.object({
  shuffle: z.boolean().default(true),
  choices: z
    .array(GapChoice.extend({ infinite: z.boolean().default(false) }))
    .min(2)
    .max(60),
  ...CombinedFeedback,
});

export const questionDataSchemas = {
  MULTICHOICE: MultichoiceData,
  TRUEFALSE: TrueFalseData,
  SHORTANSWER: ShortAnswerData,
  NUMERICAL: NumericalData,
  MATCH: MatchData,
  ESSAY: EssayData,
  DESCRIPTION: DescriptionData,
  ORDERING: OrderingData,
  GAPSELECT: GapSelectData,
  DDWTOS: DdwtosData,
  MULTIANSWER: MultianswerData,
  CALCULATED: CalculatedData,
  CALCULATEDSIMPLE: CalculatedSimpleData,
  CALCULATEDMULTI: CalculatedMultiData,
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
  /**
   * Per-attempt presentation: the order of answer ids, pair ids or ordering items, and
   * the choices (match texts, gap choice ids).
   */
  order?: string[];
  choices?: string[];
  /** Calculated questions: the variant drawn and its variables' values, as shown. */
  variant?: number;
  vars?: Record<string, string>;
}

// An empty object is a valid (blank) response of every type.
export const ResponseSchemas = {
  MULTICHOICE: z.object({ selected: z.array(z.string()).max(20).default([]) }),
  TRUEFALSE: z.object({ value: z.boolean().nullable().default(null) }),
  SHORTANSWER: z.object({ text: z.string().max(1000).default('') }),
  NUMERICAL: z.object({ text: z.string().max(100).default('') }),
  MATCH: z.object({ choices: z.record(z.string(), z.string()).default({}) }),
  ESSAY: z.object({ text: z.string().max(100_000).default('') }),
  DESCRIPTION: z.object({}),
  /** Item ids in the learner's order. */
  ORDERING: z.object({ order: z.array(z.string().max(100)).max(30).default([]) }),
  /** Gap number (1, 2, … in the order of the text) → choice id. */
  GAPSELECT: z.object({ gaps: z.record(z.string(), z.string().max(100)).default({}) }),
  DDWTOS: z.object({ gaps: z.record(z.string(), z.string().max(100)).default({}) }),
  CALCULATED: z.object({ text: z.string().max(100).default('') }),
  CALCULATEDSIMPLE: z.object({ text: z.string().max(100).default('') }),
  CALCULATEDMULTI: z.object({ selected: z.array(z.string()).max(20).default([]) }),
  /** Gap number → the text typed, the option chosen, or the options chosen. */
  MULTIANSWER: z.object({
    parts: z
      .record(z.string(), z.union([z.string().max(1000), z.array(z.string().max(100)).max(30)]))
      .default({}),
  }),
} as const;

export type QuestionResponse = z.output<(typeof ResponseSchemas)[QuestionType]>;
