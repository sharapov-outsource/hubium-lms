import type { QuestionTypeDef, QuestionTypeDefs } from '../registry.ts';
import type { QuestionType } from '../types.ts';
import { description } from './description.ts';
import { essay } from './essay.ts';
import { match } from './match.ts';
import { multichoice } from './multichoice.ts';
import { numerical } from './numerical.ts';
import { shortanswer } from './shortanswer.ts';
import { truefalse } from './truefalse.ts';

export const questionTypeDefs = {
  MULTICHOICE: multichoice,
  TRUEFALSE: truefalse,
  SHORTANSWER: shortanswer,
  NUMERICAL: numerical,
  MATCH: match,
  ESSAY: essay,
  DESCRIPTION: description,
} satisfies QuestionTypeDefs;

/** The definition of a question type (the loose signature suits snapshots read from JSON). */
export function typeDef(type: QuestionType): QuestionTypeDef<QuestionType> {
  return questionTypeDefs[type] as unknown as QuestionTypeDef<QuestionType>;
}

/** Types a quiz can draw at random and grade: everything but descriptions. */
export const gradedTypes = (Object.keys(questionTypeDefs) as QuestionType[]).filter(
  (t) => questionTypeDefs[t].grading !== 'none',
);
