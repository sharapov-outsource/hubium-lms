import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError } from '../errors.ts';
import { importGift, saveQuestion } from '../questions/bank.ts';
import { runModuleAction } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { listModules } from './registry.ts';

const GIFT = `
::Q1:: 2 + 2 = ? {=4 ~3 ~5}

::Q2:: Земля круглая {T}

::Q3:: Столица Франции {=Париж}
`;

describe('mod-quiz', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let quizId: string;
  let essayId: string;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'QUIZ1');
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const r = await importGift.run(teacher, { courseId: f.courseId, gift: GIFT });
    expect(r.created).toBe(3);
    const cat = await t.db.questionCategory.findFirstOrThrow({
      where: { contextId: f.courseId, parentId: null },
    });
    essayId = (
      await saveQuestion.run(teacher, {
        categoryId: cat.id,
        type: 'ESSAY',
        name: 'Эссе',
        text: '<p>Опишите лето</p>',
        defaultMark: 2,
        data: {},
      })
    ).id;
    quizId = (
      await f.addActivity(
        'quiz',
        'Проверочная',
        { attempts: 2, gradeMax: 10, gradePass: 6, shuffleAnswers: false, perPage: 2 },
        {
          completionMode: 'AUTO',
          completionRules: { module: { pass: true } },
        },
      )
    ).id;
    const qs = await t.db.question.findMany({
      where: { category: { contextId: f.courseId }, type: { not: 'ESSAY' } },
      orderBy: { name: 'asc' },
    });
    await runModuleAction(teacher, quizId, 'addQuestions', { questionIds: qs.map((q) => q.id) });
  });

  it('students cannot edit the quiz; teachers can preview', async () => {
    const s1 = await ctxFor(t.db, 'student1@hubium.local');
    await expect(
      runModuleAction(s1, quizId, 'addRandom', { categoryId: essayId, count: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const { attemptId } = (await runModuleAction(teacher, quizId, 'start', { preview: true })) as {
      attemptId: string;
    };
    expect((await t.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } })).preview).toBe(
      true,
    );
    await expect(runModuleAction(teacher, quizId, 'start', {})).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('a full attempt is auto-graded into the gradebook with pass completion', async () => {
    const s1 = await ctxFor(t.db, 'student1@hubium.local');
    const { attemptId } = (await runModuleAction(s1, quizId, 'start', {})) as { attemptId: string };
    // Resuming returns the same attempt.
    expect(
      ((await runModuleAction(s1, quizId, 'start', {})) as { attemptId: string }).attemptId,
    ).toBe(attemptId);
    const qas = await t.db.questionAttempt.findMany({
      where: { attemptId },
      orderBy: { slot: 'asc' },
    });
    expect(qas.map((q) => q.page)).toEqual([1, 1, 2]);
    const answers: Record<string, unknown> = {};
    for (const qa of qas) {
      const snap = qa.snapshot as {
        type: string;
        data: { answers?: { id: string; text: string; fraction: number }[] };
      };
      if (snap.type === 'MULTICHOICE')
        answers[qa.slot] = { selected: [snap.data.answers!.find((a) => a.fraction === 1)!.id] };
      if (snap.type === 'TRUEFALSE') answers[qa.slot] = { value: true };
      if (snap.type === 'SHORTANSWER') answers[qa.slot] = { text: 'париж' };
    }
    await runModuleAction(s1, quizId, 'save', { attemptId, answers });
    await runModuleAction(s1, quizId, 'finish', { attemptId });
    const at = await t.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(at.state).toBe('FINISHED');
    expect(Number(at.sumGrades)).toBe(3);
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: quizId } });
    const g = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student1! } },
    });
    expect(Number(g.finalGrade)).toBe(10);
    const c = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: quizId, userId: f.users.student1! } },
    });
    expect(c.state).toBe('COMPLETE_PASS');
    await expect(runModuleAction(s1, quizId, 'save', { attemptId, answers })).rejects.toThrow(
      /closed/,
    );
  });

  it('attempt limit is enforced and the highest grade wins', async () => {
    const s2 = await ctxFor(t.db, 'student2@hubium.local');
    for (const correct of [false, true]) {
      const { attemptId } = (await runModuleAction(s2, quizId, 'start', {})) as {
        attemptId: string;
      };
      const qas = await t.db.questionAttempt.findMany({ where: { attemptId } });
      const answers = Object.fromEntries(
        qas.map((qa) => {
          const snap = qa.snapshot as { type: string };
          return [
            qa.slot,
            snap.type === 'TRUEFALSE'
              ? { value: correct }
              : snap.type === 'SHORTANSWER'
                ? { text: 'x' }
                : { selected: [] },
          ];
        }),
      );
      await runModuleAction(s2, quizId, 'finish', { attemptId, answers });
    }
    await expect(runModuleAction(s2, quizId, 'start', {})).rejects.toThrow(/No attempts left/);
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: quizId } });
    const g = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student2! } },
    });
    expect(Number(g.finalGrade)).toBeCloseTo(10 / 3);
    const c = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: quizId, userId: f.users.student2! } },
    });
    expect(c.state).toBe('COMPLETE_FAIL');
  });

  it('essays wait for manual grading; then the grade appears', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const { id } = await f.addActivity('quiz', 'Эссе-тест', { attempts: 0, gradeMax: 10 });
    await runModuleAction(teacher, id, 'addQuestions', { questionIds: [essayId] });
    const s3 = await ctxFor(t.db, 'student3@hubium.local');
    const { attemptId } = (await runModuleAction(s3, id, 'start', {})) as { attemptId: string };
    await runModuleAction(s3, id, 'finish', {
      attemptId,
      answers: { '1': { text: '<p>Тёплое лето</p>' } },
    });
    const at = await t.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(at.needsManualGrading).toBe(true);
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: id } });
    // no grade yet (nor an empty one)
    expect(
      (
        await t.db.grade.findUnique({
          where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student3! } },
        })
      )?.finalGrade ?? null,
    ).toBeNull();
    const quiz = listModules().find((m) => m.key === 'quiz')!;
    expect(
      (await quiz.todo!(buildModuleCtx(teacher), f.users.teacher!, [f.courseId])).find(
        (x) => x.activityId === id,
      )?.count,
    ).toBe(1);
    const qa = await t.db.questionAttempt.findFirstOrThrow({ where: { attemptId } });
    await expect(
      runModuleAction(teacher, id, 'gradeQuestion', { questionAttemptId: qa.id, mark: 3 }),
    ).rejects.toThrow(/at most/);
    await runModuleAction(teacher, id, 'gradeQuestion', {
      questionAttemptId: qa.id,
      mark: 1.5,
      comment: 'Неплохо',
    });
    const g = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student3! } },
    });
    expect(Number(g.finalGrade)).toBeCloseTo(7.5);
  });

  it('random slots draw distinct questions from a category', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const cat = await t.db.questionCategory.findFirstOrThrow({
      where: { contextId: f.courseId, parentId: null },
    });
    const { id } = await f.addActivity('quiz', 'Случайный', { attempts: 0 });
    await runModuleAction(teacher, id, 'addRandom', { categoryId: cat.id, count: 3 });
    const s1 = await ctxFor(t.db, 'student1@hubium.local');
    const { attemptId } = (await runModuleAction(s1, id, 'start', {})) as { attemptId: string };
    const qs = await t.db.questionAttempt.findMany({ where: { attemptId } });
    expect(new Set(qs.map((q) => q.questionId)).size).toBe(3);
    // Editing a question later does not change the frozen snapshot.
    const q = await t.db.question.findUniqueOrThrow({ where: { id: qs[0]!.questionId } });
    await t.db.question.update({ where: { id: q.id }, data: { text: '<p>изменено</p>' } });
    const again = await t.db.questionAttempt.findUniqueOrThrow({ where: { id: qs[0]!.id } });
    expect((again.snapshot as { text: string }).text).toBe(q.text);
  });

  it('time limit: the sweeper closes overdue attempts', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const { id } = await f.addActivity('quiz', 'На время', { attempts: 0, timeLimitMin: 1 });
    const q = await t.db.question.findFirstOrThrow({
      where: { category: { contextId: f.courseId }, type: 'TRUEFALSE' },
    });
    await runModuleAction(teacher, id, 'addQuestions', { questionIds: [q.id] });
    const s2 = await ctxFor(t.db, 'student2@hubium.local');
    const { attemptId } = (await runModuleAction(s2, id, 'start', {})) as { attemptId: string };
    await runModuleAction(s2, id, 'save', { attemptId, answers: { '1': { value: true } } });
    const dueAt = new Date(Date.now() - 5 * 60_000);
    await t.db.quizAttempt.update({ where: { id: attemptId }, data: { dueAt } });
    // an essay quiz left open as well: its markers hear of it
    const { id: essayQuiz } = await f.addActivity('quiz', 'Эссе на время', {
      attempts: 0,
      timeLimitMin: 1,
    });
    await runModuleAction(teacher, essayQuiz, 'addQuestions', { questionIds: [essayId] });
    const open = (await runModuleAction(s2, essayQuiz, 'start', {})) as { attemptId: string };
    await runModuleAction(s2, essayQuiz, 'save', {
      attemptId: open.attemptId,
      answers: { '1': { text: 'Тёплое' } },
    });
    await t.db.quizAttempt.update({ where: { id: open.attemptId }, data: { dueAt } });
    const notices = () =>
      t.db.notification.count({
        where: { userId: f.users.teacher, type: 'quiz.needsGrading', contextId: essayQuiz },
      });
    expect(await notices()).toBe(0);

    const quiz = listModules().find((m) => m.key === 'quiz')!;
    const sys = await ctxFor(t.db, 'system');
    // as the worker runs it, in a transaction
    await t.db.$transaction((tx) => quiz.cron![0]!.handler(buildModuleCtx(sys, tx)));
    const at = await t.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(at.state).toBe('FINISHED');
    expect(Number(at.sumGrades)).toBe(1);
    // it ended when its time ran out (and the minute's grace), not when the sweep came
    expect(at.finishedAt?.getTime()).toBe(dueAt.getTime() + 60_000);
    expect(await notices()).toBe(1);
  });

  it('time limit: a late save submits the attempt instead of failing', async () => {
    const { id } = await f.addActivity('quiz', 'На время 2', { attempts: 0, timeLimitMin: 1 });
    const q = await t.db.question.findFirstOrThrow({
      where: { category: { contextId: f.courseId }, type: 'TRUEFALSE' },
    });
    await runModuleAction(await ctxFor(t.db, 'teacher@hubium.local'), id, 'addQuestions', {
      questionIds: [q.id],
    });
    const s3 = await ctxFor(t.db, 'student3@hubium.local');
    const { attemptId } = (await runModuleAction(s3, id, 'start', {})) as { attemptId: string };
    await t.db.quizAttempt.update({
      where: { id: attemptId },
      data: { dueAt: new Date(Date.now() - 5 * 60_000) },
    });
    expect(
      await runModuleAction(s3, id, 'save', { attemptId, answers: { '1': { value: true } } }),
    ).toMatchObject({ closed: true });
    const at = await t.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(at.state).toBe('FINISHED');
  });
});
