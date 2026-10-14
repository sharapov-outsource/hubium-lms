import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import type { RequestContext } from '../context.ts';
import { updateActivity } from '../courses/activities.ts';
import { listQuestionCategories, saveQuestion } from '../questions/bank.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

type Live = {
  slot: number;
  response: unknown;
  state: 'TODO' | 'TRYAGAIN' | 'COMPLETE';
  canCheck: boolean;
  triesLeft: number | null;
  feedback: {
    verdict: string;
    mark: number | null;
    texts: string[];
    hint: string | null;
    numCorrect: { right: number; total: number } | null;
    rightAnswer: string | null;
  } | null;
};

describe('quiz question behaviours', () => {
  const t = useTestDb();

  async function setup(code: string, settings: Record<string, unknown>) {
    const f = await courseFixture(t.db, code);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const [cat] = await listQuestionCategories(teacher, f.courseId);
    const save = (input: Record<string, unknown>) =>
      saveQuestion.run(teacher, {
        categoryId: cat!.id,
        text: '<p>?</p>',
        defaultMark: 1,
        ...input,
      } as never);
    const sum = await save({
      type: 'NUMERICAL',
      name: 'А сумма',
      penalty: 0.25,
      hints: [{ text: '<p>Сложите</p>' }, { text: '<p>Посчитайте на пальцах</p>' }],
      data: {
        answers: [
          { value: 4, tolerance: 0, fraction: 1, feedback: '<p>Верно</p>' },
          { value: 5, tolerance: 0, fraction: 0.5, feedback: '<p>Почти</p>' },
        ],
      },
    });
    const primes = await save({
      type: 'MULTICHOICE',
      name: 'Б простые',
      penalty: 0.1,
      hints: [{ text: '<p>Ещё раз</p>', clearWrong: true, showNumCorrect: true }],
      data: {
        single: false,
        shuffleAnswers: false,
        answers: [
          { id: 'a', text: '2', fraction: 0.5 },
          { id: 'b', text: '3', fraction: 0.5 },
          { id: 'c', text: '4', fraction: -1 },
        ],
      },
    });
    const essay = await save({ type: 'ESSAY', name: 'В эссе', data: {} });
    const quizId = (
      await f.addActivity('quiz', 'Тест', {
        attempts: 0,
        shuffleAnswers: false,
        perPage: 0,
        ...settings,
      })
    ).id;
    await runModuleAction(teacher, quizId, 'addQuestions', {
      questionIds: [sum.id, primes.id, essay.id],
    });
    const student = await ctxFor(t.db, f.users.student1!);
    const { attemptId } = (await runModuleAction(student, quizId, 'start', {})) as {
      attemptId: string;
    };
    return { f, teacher, student, quizId, attemptId, sumId: sum.id };
  }

  const act = async (ctx: RequestContext, quizId: string, name: string, input: object) =>
    ((await runModuleAction(ctx, quizId, name, input)) as { question: Live }).question;
  const read = async (ctx: RequestContext, quizId: string, attemptId: string) =>
    (
      (await runModuleQuery(ctx, quizId, 'attempt', { attemptId })) as {
        behaviour: string;
        questions: Live[];
      }
    ).questions;

  it('interactive: hints between tries, a penalty for each wrong one', async () => {
    const { teacher, student, quizId, attemptId, sumId } = await setup('QBH1', {
      behaviour: 'interactive',
    });
    const before = await read(student, quizId, attemptId);
    expect(before.map((q) => [q.canCheck, q.triesLeft])).toEqual([
      [true, 3],
      [true, 2],
      [false, null],
    ]);
    const check = (slot: number, response: object) =>
      act(student, quizId, 'check', { attemptId, slot, response });
    const tryAgain = (slot: number) => act(student, quizId, 'tryAgain', { attemptId, slot });

    const first = await check(1, { text: '3' });
    expect(first).toMatchObject({ state: 'TRYAGAIN', canCheck: false, triesLeft: 2 });
    expect(first.feedback).toMatchObject({
      verdict: 'incorrect',
      mark: null,
      hint: '<p>Сложите</p>',
    });
    // a checked answer stays as it was until the learner tries again
    await runModuleAction(student, quizId, 'save', { attemptId, answers: { 1: { text: '4' } } });
    expect((await read(student, quizId, attemptId))[0]!.response).toEqual({ text: '3' });
    await expect(check(1, { text: '4' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await tryAgain(1)).toMatchObject({
      state: 'TODO',
      canCheck: true,
      feedback: null,
      response: { text: '3' },
    });
    const right = await check(1, { text: '4' });
    expect(right).toMatchObject({ state: 'COMPLETE', triesLeft: 1 });
    expect(right.feedback).toMatchObject({
      verdict: 'correct',
      mark: 0.75,
      texts: ['<p>Верно</p>'],
    });

    // the hint counts right parts and clears the wrong ones
    const mc = await check(2, { selected: ['a', 'c'] });
    expect(mc.feedback?.numCorrect).toEqual({ right: 1, total: 2 });
    expect((await tryAgain(2)).response).toEqual({ selected: ['a'] });
    expect((await check(2, { selected: ['a', 'b'] })).feedback?.mark).toBeCloseTo(0.9);

    // essays are graded by hand, never checked; an empty answer is not checked either
    await expect(check(3, { text: '<p>Лето</p>' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await runModuleAction(student, quizId, 'finish', {
      attemptId,
      answers: { 3: { text: '<p>Лето</p>' } },
    });
    const at = await t.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(Number(at.sumGrades)).toBeCloseTo(1.65);
    expect(at).toMatchObject({ behaviour: 'interactive', needsManualGrading: true });

    // review: feedback on the answer for everyone, the step history for teachers
    type Review = {
      questions: {
        answerFeedback: string[];
        history: { kind: string; fraction: number | null }[] | null;
      }[];
    };
    const own = (await runModuleQuery(student, quizId, 'review', { attemptId })) as Review;
    expect(own.questions[0]).toMatchObject({ answerFeedback: ['<p>Верно</p>'], history: null });
    const full = (await runModuleQuery(teacher, quizId, 'review', { attemptId })) as Review;
    expect(full.questions[0]!.history!.map((s) => s.kind)).toEqual([
      'CHECK',
      'TRYAGAIN',
      'CHECK',
      'FINISH',
    ]);
    expect(full.questions[0]!.history!.at(-1)!.fraction).toBe(0.75);

    // regrading replays the tries: unchanged questions, unchanged marks; a new penalty counts
    const dry = (await runModuleAction(teacher, quizId, 'regrade', { dryRun: true })) as {
      attempts: { before: number; after: number }[];
    };
    expect(dry.attempts.map((x) => x.after - x.before)).toEqual([0]);
    await t.db.question.update({ where: { id: sumId }, data: { penalty: 0.5 } });
    const after = (await runModuleAction(teacher, quizId, 'regrade', { dryRun: false })) as {
      attempts: { after: number }[];
    };
    expect(after.attempts[0]!.after).toBeCloseTo(1.4);
  });

  it('immediate: one check grades and locks; the attempt keeps its behaviour', async () => {
    const { teacher, student, quizId, attemptId } = await setup('QBH2', {
      behaviour: 'immediate',
      duringRightAnswer: true,
    });
    const q = await act(student, quizId, 'check', { attemptId, slot: 1, response: { text: '5' } });
    expect(q).toMatchObject({ state: 'COMPLETE', canCheck: false, triesLeft: null });
    expect(q.feedback).toMatchObject({ verdict: 'partial', mark: 0.5, rightAnswer: '4' });
    await expect(
      act(student, quizId, 'check', { attemptId, slot: 1, response: { text: '4' } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(act(student, quizId, 'tryAgain', { attemptId, slot: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      act(student, quizId, 'check', { attemptId, slot: 2, response: { selected: [] } }),
    ).rejects.toThrow(/Answer the question/);

    // a change of behaviour applies to new attempts only
    await updateActivity.run(teacher, {
      id: quizId,
      name: 'Тест',
      settings: { attempts: 0, perPage: 0, behaviour: 'deferred' },
    });
    await act(student, quizId, 'check', { attemptId, slot: 2, response: { selected: ['a'] } });
    await runModuleAction(student, quizId, 'finish', { attemptId });
    const next = ((await runModuleAction(student, quizId, 'start', {})) as { attemptId: string })
      .attemptId;
    const fresh = await read(student, quizId, next);
    expect(fresh.every((x) => !x.canCheck && x.feedback === null)).toBe(true);
    await expect(
      act(student, quizId, 'check', { attemptId: next, slot: 1, response: { text: '4' } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('hides feedback and hints during the attempt when the quiz says so', async () => {
    const { student, quizId, attemptId } = await setup('QBH3', {
      behaviour: 'interactive',
      duringFeedback: false,
      reviewMarks: false,
    });
    const q = await act(student, quizId, 'check', { attemptId, slot: 1, response: { text: '3' } });
    expect(q.feedback).toEqual({
      verdict: 'incorrect',
      mark: null,
      texts: [],
      hint: null,
      numCorrect: null,
      rightAnswer: null,
    });
  });
});
