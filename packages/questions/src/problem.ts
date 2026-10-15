// What is wrong with a question, for people: the key of its message in the language packs
// (errors.questions.…) and the message's values. The package has no language packs of its
// own: whoever shows a problem puts it in the person's language.

export interface Problem {
  key: string;
  values?: Record<string, string | number>;
}

export const problem = (key: string, values?: Problem['values']): Problem => ({ key, values });

/** A problem thrown, as a parser does on a block it cannot read. */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.key);
    this.name = 'ProblemError';
  }
}
