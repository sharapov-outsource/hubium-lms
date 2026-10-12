import { z } from 'zod';
import type { QuestionData, QuestionType } from './types.ts';

// The shape AI quiz generation asks the model for. It is deliberately flat (no unions) so
// it maps onto provider structured-output schemas; `draftToQuestion` turns it into a
// regular question, which the stored-data schemas validate as usual.

export const draftTypes = ['MULTICHOICE', 'TRUEFALSE', 'SHORTANSWER', 'NUMERICAL'] as const;
export type DraftType = (typeof draftTypes)[number];

export const QuestionDraft = z.object({
  type: z.enum(draftTypes),
  name: z.string().describe('Short title, at most 8 words'),
  text: z.string().describe('The question as plain text'),
  explanation: z.string().describe('Why the correct answer is correct; shown after answering'),
  sourceIndex: z
    .number()
    .int()
    .nullable()
    .describe('Number of the source excerpt the question is based on'),
  options: z
    .array(z.object({ text: z.string(), correct: z.boolean(), feedback: z.string() }))
    .describe('MULTICHOICE only: 3-5 options; empty for other types'),
  trueFalseAnswer: z.boolean().nullable().describe('TRUEFALSE only; null otherwise'),
  acceptedAnswers: z
    .array(z.string())
    .describe('SHORTANSWER only: accepted spellings, best first; empty otherwise'),
  numericAnswer: z.number().nullable().describe('NUMERICAL only; null otherwise'),
  tolerance: z.number().nullable().describe('NUMERICAL only: allowed absolute error'),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export const QuestionDraftList = z.object({ questions: z.array(QuestionDraft) });

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

/** Maps a draft to question fields, or returns an error message when it is unusable. */
export function draftToQuestion(
  d: QuestionDraft,
):
  | { type: QuestionType; name: string; text: string; generalFeedback: string; data: QuestionData }
  | { error: string } {
  const base = {
    name: d.name.trim().slice(0, 255) || d.text.slice(0, 60),
    text: `<p>${esc(d.text.trim())}</p>`,
    generalFeedback: d.explanation.trim() ? `<p>${esc(d.explanation.trim())}</p>` : '',
  };
  if (!d.text.trim()) return { error: 'Empty question text' };
  switch (d.type) {
    case 'MULTICHOICE': {
      const opts = d.options.filter((o) => o.text.trim());
      const correct = opts.filter((o) => o.correct).length;
      if (opts.length < 2 || correct === 0)
        return { error: 'Needs at least two options and a correct one' };
      return {
        ...base,
        type: 'MULTICHOICE',
        data: {
          single: correct === 1,
          shuffleAnswers: true,
          answers: opts.map((o, i) => ({
            id: `a${i + 1}`,
            text: o.text.trim(),
            fraction: o.correct
              ? 1 / correct
              : correct === 1
                ? 0
                : -1 / Math.max(1, opts.length - correct),
            feedback: o.feedback,
          })),
        },
      };
    }
    case 'TRUEFALSE':
      if (d.trueFalseAnswer === null) return { error: 'Missing true/false answer' };
      return {
        ...base,
        type: 'TRUEFALSE',
        data: { correct: d.trueFalseAnswer, feedbackTrue: '', feedbackFalse: '' },
      };
    case 'SHORTANSWER': {
      const answers = [...new Set(d.acceptedAnswers.map((a) => a.trim()).filter(Boolean))];
      if (!answers.length) return { error: 'No accepted answers' };
      return {
        ...base,
        type: 'SHORTANSWER',
        data: {
          caseSensitive: false,
          answers: answers.slice(0, 20).map((text) => ({ text, fraction: 1, feedback: '' })),
        },
      };
    }
    case 'NUMERICAL':
      if (d.numericAnswer === null || !Number.isFinite(d.numericAnswer))
        return { error: 'Missing numeric answer' };
      return {
        ...base,
        type: 'NUMERICAL',
        data: {
          answers: [
            {
              value: d.numericAnswer,
              tolerance: Math.abs(d.tolerance ?? 0),
              fraction: 1,
              feedback: '',
            },
          ],
        },
      };
  }
}
