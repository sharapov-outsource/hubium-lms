import { lenientOverride } from '@hubium/mod-quiz/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { ForbiddenError } from '../errors.ts';
import { createGroup, setGroupMembers } from '../groups/groups.ts';
import { importGift, saveQuestion } from '../questions/bank.ts';
import { runModuleAction } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { listModules } from './registry.ts';

type Report = {
  attempts: { before: number; after: number; maxBefore: number; maxAfter: number }[];
  skipped: string[];
};

describe('quiz overrides', () => {
  it('merges group overrides in the learner’s favour', () => {
    const d = (s: string) => new Date(s);
    expect(
      lenientOverride([
        { openAt: d('2026-01-02'), closeAt: d('2026-02-01'), timeLimitSec: 600, attempts: 2 },
        { openAt: d('2026-01-01'), closeAt: null, timeLimitSec: 0, attempts: 3 },
        { openAt: null, closeAt: d('2026-03-01'), timeLimitSec: 900, attempts: null },
      ]),
    ).toEqual({
      openAt: d('2026-01-01'),
      closeAt: d('2026-03-01'),
      timeLimitSec: 0,
      attempts: 3,
    });
  });
});

describe('quiz overrides and regrading', () => {
  const t = useTestDb();

  async function setup(code: string, settings: Record<string, unknown>) {
    const f = await courseFixture(t.db, code);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await importGift.run(teacher, {
      courseId: f.courseId,
      gift: '::Город:: Столица Франции {=Париж}',
    });
    const quizId = (await f.addActivity('quiz', 'Тест', { gradeMax: 10, ...settings })).id;
    const qs = await t.db.question.findMany({ where: { category: { contextId: f.courseId } } });
    await runModuleAction(teacher, quizId, 'addQuestions', { questionIds: qs.map((q) => q.id) });
    return { f, teacher, quizId, question: qs[0]! };
  }

  const answer = async (ctxUser: string, quizId: string, text: string) => {
    const ctx = await ctxFor(t.db, ctxUser);
    const { attemptId } = (await runModuleAction(ctx, quizId, 'start', {})) as {
      attemptId: string;
    };
    await runModuleAction(ctx, quizId, 'save', { attemptId, answers: { 1: { text } } });
    await runModuleAction(ctx, quizId, 'finish', { attemptId });
    return attemptId;
  };

  it('lets one learner and the members of a group in after the quiz closed', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { f, teacher, quizId } = await setup('QOV1', { closeAt: past, attempts: 1 });
    const { id: groupId } = await createGroup.run(teacher, {
      courseId: f.courseId,
      name: 'Поздние',
    });
    await setGroupMembers.run(teacher, { groupId, add: [f.users.student2!] });

    await runModuleAction(teacher, quizId, 'setOverride', {
      userId: f.users.student1,
      closeAt: future,
    });
    await runModuleAction(teacher, quizId, 'setOverride', {
      groupId,
      closeAt: future,
      attempts: 2,
    });
    const student = await ctxFor(t.db, f.users.student3!);
    await expect(
      runModuleAction(student, quizId, 'setOverride', { userId: f.users.student3, attempts: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runModuleAction(student, quizId, 'start', {})).rejects.toThrow();

    await answer(f.users.student1!, quizId, 'Париж');
    // the group override grants a second attempt
    await answer(f.users.student2!, quizId, 'Лион');
    await answer(f.users.student2!, quizId, 'Париж');
    await expect(
      runModuleAction(await ctxFor(t.db, f.users.student2!), quizId, 'start', {}),
    ).rejects.toThrow();

    // "to do" shows the learner's own deadline
    const quiz = listModules().find((m) => m.key === 'quiz')!;
    const fresh = await setup('QOV1B', { closeAt: past, attempts: 1 });
    await runModuleAction(fresh.teacher, fresh.quizId, 'setOverride', {
      userId: fresh.f.users.student1,
      closeAt: future,
    });
    const s1 = await ctxFor(t.db, fresh.f.users.student1!);
    const todo = await quiz.todo!(buildModuleCtx(s1), fresh.f.users.student1!, [fresh.f.courseId]);
    expect(todo).toMatchObject([{ activityId: fresh.quizId, dueAt: new Date(future) }]);
  });

  it('regrades attempts after a question was corrected; a dry run changes nothing', async () => {
    const { f, teacher, quizId, question } = await setup('QOV2', { attempts: 1 });
    const attemptId = await answer(f.users.student1!, quizId, 'Лион');
    const grade = async () => {
      const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: quizId } });
      const g = await t.db.grade.findFirst({
        where: { gradeItemId: item.id, userId: f.users.student1! },
      });
      return g?.finalGrade === null || g?.finalGrade === undefined ? null : Number(g.finalGrade);
    };
    expect(await grade()).toBe(0);

    // Lyon was a correct answer as well
    await saveQuestion.run(teacher, {
      id: question.id,
      categoryId: question.categoryId,
      type: 'SHORTANSWER',
      name: question.name,
      text: question.text,
      defaultMark: 1,
      data: {
        caseSensitive: false,
        answers: [
          { text: 'Париж', fraction: 1 },
          { text: 'Лион', fraction: 1 },
        ],
      },
    });
    const dry = (await runModuleAction(teacher, quizId, 'regrade', { dryRun: true })) as Report;
    expect(dry.attempts).toMatchObject([{ before: 0, after: 1 }]);
    expect(await grade()).toBe(0);

    await runModuleAction(teacher, quizId, 'regrade', { dryRun: false });
    expect(
      Number((await t.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } })).sumGrades),
    ).toBe(1);
    expect(await grade()).toBe(10);
    const event = await t.db.eventLog.findFirst({ where: { name: 'quiz.regraded' } });
    expect(event?.data).toMatchObject({ attempts: 1, changed: 1 });
  });

  it('gives an open attempt the time limit and close date set after it began', async () => {
    const { f, teacher, quizId } = await setup('QOVR3', { timeLimitMin: 10 });
    const start = async (userId: string) => {
      const { attemptId } = (await runModuleAction(
        await ctxFor(t.db, userId),
        quizId,
        'start',
        {},
      )) as {
        attemptId: string;
      };
      return attemptId;
    };
    const dueOf = async (id: string) =>
      (await t.db.quizAttempt.findUniqueOrThrow({ where: { id } })).dueAt?.getTime() ?? null;
    const minutes = (n: number) => n * 60_000;
    const s1 = await start(f.users.student1!);
    const begun = (await t.db.quizAttempt.findUniqueOrThrow({ where: { id: s1 } })).startedAt;
    expect(await dueOf(s1)).toBe(begun.getTime() + minutes(10));
    // the browser failed: 30 minutes more
    const { id } = (await runModuleAction(teacher, quizId, 'setOverride', {
      userId: f.users.student1,
      timeLimitMin: 40,
    })) as { id: string };
    expect(await dueOf(s1)).toBe(begun.getTime() + minutes(40));
    await runModuleAction(teacher, quizId, 'deleteOverride', { id });
    expect(await dueOf(s1)).toBe(begun.getTime() + minutes(10));

    // no limit, then a close date: the attempt closes with the quiz
    const quiz = await t.db.activity.findUniqueOrThrow({ where: { id: quizId } });
    const settings = (over: Record<string, unknown>) =>
      updateActivity.run(teacher, {
        id: quizId,
        name: quiz.name,
        settings: { ...(quiz.settings as object), ...over },
      });
    await settings({ timeLimitMin: 0 });
    expect(await dueOf(s1)).toBeNull();
    const closeAt = new Date(Date.now() + minutes(60));
    await settings({ timeLimitMin: 0, closeAt: closeAt.toISOString() });
    expect(await dueOf(s1)).toBe(closeAt.getTime());
  });
});
