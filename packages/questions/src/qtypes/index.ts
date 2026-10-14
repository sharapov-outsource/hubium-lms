import type { QuestionTypeDef, QuestionTypeDefs } from '../registry.ts';
import type { QuestionType } from '../types.ts';
import { calculated, calculatedMulti, calculatedSimple } from './calculated.ts';
import { multianswer } from './cloze.ts';
import { description } from './description.ts';
import { essay } from './essay.ts';
import { ddwtos, gapselect } from './gaps.ts';
import { match } from './match.ts';
import { multichoice } from './multichoice.ts';
import { numerical } from './numerical.ts';
import { ordering } from './ordering.ts';
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
  ORDERING: ordering,
  GAPSELECT: gapselect,
  DDWTOS: ddwtos,
  MULTIANSWER: multianswer,
  CALCULATED: calculated,
  CALCULATEDSIMPLE: calculatedSimple,
  CALCULATEDMULTI: calculatedMulti,
} satisfies QuestionTypeDefs;

/** The definition of a question type (the loose signature suits snapshots read from JSON). */
export function typeDef(type: QuestionType): QuestionTypeDef<QuestionType> {
  return questionTypeDefs[type] as unknown as QuestionTypeDef<QuestionType>;
}

/** Types a quiz can draw at random and grade: everything but descriptions. */
export const gradedTypes = (Object.keys(questionTypeDefs) as QuestionType[]).filter(
  (t) => questionTypeDefs[t].grading !== 'none',
);
