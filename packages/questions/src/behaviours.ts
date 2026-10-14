import { gradeResponse } from './grade.ts';
import { typeDef } from './qtypes/index.ts';
import type { QuestionView } from './registry.ts';
import { type Hint, type QuestionSnapshot, ResponseSchemas } from './types.ts';

// How a question in an attempt behaves, as Moodle's question behaviours:
//   deferred     answers are graded when the attempt is finished
//   immediate    each question can be checked once; checking grades and locks it
//   interactive  checking a wrong answer shows the next hint and costs `penalty` of the
//                mark; the learner tries again until right or out of tries (hints + 1).
//                Types made of parts (countback) are graded part by part instead, each
//                part losing the penalty for its own wrong tries (Moodle's "interactive
//                with countback").
// The steps of a question are replayed to get its state and grade, so finishing,
// manual grading and regrading all compute the same way. Questions graded by hand
// (essays) always behave as deferred.

export const behaviours = ['deferred', 'immediate', 'interactive'] as const;
export type Behaviour = (typeof behaviours)[number];

export type StepKind = 'SAVE' | 'CHECK' | 'TRYAGAIN' | 'FINISH' | 'MANUALGRADE';

export interface Step {
  kind: StepKind;
  response?: unknown;
  /** MANUALGRADE: the share of the mark a teacher gave. */
  fraction?: number | null;
}

export type QuestionState = 'TODO' | 'TRYAGAIN' | 'COMPLETE';

export interface Outcome {
  /** The grade as a share of the mark, penalties applied; null until graded. */
  fraction: number | null;
  /** The last graded response's share before penalties. */
  rawFraction: number | null;
  needsGrading: boolean;
  state: QuestionState;
  /** Checks made (interactive and immediate). */
  tries: number;
  maxTries: number;
  /** The response in effect. */
  response: unknown;
  /** Per-answer feedback of the last grading. */
  feedback: string[];
  /** The hint after an unsuccessful try. */
  hint: Hint | null;
  /** Right parts of the last checked response, when its hint asks to show them. */
  numCorrect: { right: number; total: number } | null;
  /** A teacher set the grade. */
  manual: boolean;
}

type Replayable = Pick<
  QuestionSnapshot,
  'type' | 'data' | 'order' | 'choices' | 'penalty' | 'hints'
> & { text?: string };

/** The behaviour a question really has: graded-by-hand and ungraded ones defer. */
export function behaviourOf(q: Pick<QuestionSnapshot, 'type'>, b: Behaviour): Behaviour {
  return typeDef(q.type).grading === 'auto' ? b : 'deferred';
}

/** Tries a question allows: interactive one more than its hints, otherwise one. */
export function maxTries(q: Pick<QuestionSnapshot, 'type' | 'hints'>, b: Behaviour): number {
  return behaviourOf(q, b) === 'interactive' ? (q.hints?.length ?? 0) + 1 : 1;
}

const RIGHT = 1 - 1e-9;

function partsOf(q: Replayable, response: unknown) {
  const def = typeDef(q.type);
  const parsed = ResponseSchemas[q.type].safeParse(response ?? {});
  return def.parts && parsed.success ? def.parts(q as QuestionView, parsed.data as never) : null;
}

/**
 * The response for the next try: without its wrong parts when the type can tell them
 * apart, otherwise empty (a wrong single answer is simply cleared).
 */
export function clearWrongParts(q: Replayable, response: unknown): unknown {
  const def = typeDef(q.type);
  const parsed = ResponseSchemas[q.type].safeParse(response ?? {});
  if (!parsed.success) return {};
  if (def.clearWrong) return def.clearWrong(q as QuestionView, parsed.data as never);
  return (gradeResponse(q, response).fraction ?? 0) >= RIGHT ? response : {};
}

/** The grade of the tries so far, part by part, for types that grade that way. */
function countback(q: Replayable, responses: unknown[], penalty: number): number | null {
  const def = typeDef(q.type);
  if (!def.countback || !responses.length) return null;
  const parsed = responses.map((r) => {
    const p = ResponseSchemas[q.type].safeParse(r ?? {});
    return p.success ? p.data : ResponseSchemas[q.type].parse({});
  });
  return def.countback(q as QuestionView, parsed as never, penalty);
}

export function replay(q: Replayable, steps: Step[], behaviour: Behaviour): Outcome {
  const b = behaviourOf(q, behaviour);
  const hints = q.hints ?? [];
  const penalty = q.penalty ?? 0;
  const tryLimit = maxTries(q, b);
  // the responses of the checks, for countback
  const checked: unknown[] = [];
  const out: Outcome = {
    fraction: null,
    rawFraction: null,
    needsGrading: false,
    state: 'TODO',
    tries: 0,
    maxTries: tryLimit,
    response: null,
    feedback: [],
    hint: null,
    numCorrect: null,
    manual: false,
  };
  for (const s of steps) {
    switch (s.kind) {
      case 'SAVE':
        if (out.state === 'TODO' && s.response !== undefined) out.response = s.response;
        break;
      case 'CHECK': {
        if (b === 'deferred' || out.state !== 'TODO') break;
        if (s.response !== undefined) out.response = s.response;
        out.tries++;
        checked.push(out.response);
        const r = gradeResponse(q, out.response);
        const raw = r.fraction ?? 0;
        out.rawFraction = raw;
        out.feedback = r.feedback;
        if (b === 'immediate' || raw >= RIGHT || out.tries >= tryLimit) {
          out.state = 'COMPLETE';
          out.fraction =
            b === 'interactive'
              ? (countback(q, checked, penalty) ?? Math.max(0, raw - penalty * (out.tries - 1)))
              : raw;
          out.hint = null;
          out.numCorrect = null;
        } else {
          out.state = 'TRYAGAIN';
          out.hint = hints[out.tries - 1] ?? null;
          out.numCorrect = out.hint?.showNumCorrect ? partsOf(q, out.response) : null;
        }
        break;
      }
      case 'TRYAGAIN':
        if (out.state !== 'TRYAGAIN') break;
        out.state = 'TODO';
        if (s.response !== undefined) out.response = s.response;
        out.hint = null;
        out.numCorrect = null;
        out.feedback = [];
        break;
      case 'FINISH': {
        if (out.state === 'COMPLETE') break;
        const r = gradeResponse(q, out.response);
        out.rawFraction = r.fraction;
        out.feedback = r.feedback;
        out.needsGrading = r.needsGrading;
        // As Moodle: every check so far was wrong and costs the penalty. The answer as it
        // stands is graded, and counts as one more response unless it waits for a new try.
        const responses = out.state === 'TODO' ? [...checked, out.response] : checked;
        out.fraction =
          r.fraction === null
            ? null
            : b === 'interactive'
              ? (countback(q, responses, penalty) ?? Math.max(0, r.fraction - penalty * out.tries))
              : r.fraction;
        out.state = 'COMPLETE';
        out.hint = null;
        out.numCorrect = null;
        break;
      }
      case 'MANUALGRADE':
        out.fraction = s.fraction ?? null;
        out.needsGrading = false;
        out.manual = true;
        break;
    }
  }
  return out;
}
