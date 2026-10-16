import { markedBy } from '@hubium/mod-assign/server';
import { attemptsSeenBy, readReview, regradeQuiz } from '@hubium/mod-quiz/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { invalidatePermissionCaches } from '../access/permissions.ts';
import { enrolUsers } from '../enrol/enrol.ts';
import { importGift } from '../questions/bank.ts';
import { runModuleAction } from './actions.ts';
import { buildModuleCtx, toActivityRef } from './module-ctx.ts';
import { getModule } from './registry.ts';

describe('separate groups in assignments and quizzes', () => {
  const t = useTestDb();

  it('a marker who sees only their group marks and reviews only its work', async () => {
    const f = await courseFixture(t.db, 'GRPMODE');
    const admin = await ctxFor(t.db, 'admin@test.local');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const assistantRole = await t.db.role.findUniqueOrThrow({ where: { shortName: 'teacher' } });
    await enrolUsers.run(admin, {
      courseId: f.courseId,
      userIds: [f.users.assistant!],
      roleId: assistantRole.id,
    });
    await t.db.roleOverride.create({
      data: {
        contextId: f.courseId,
        roleId: assistantRole.id,
        capability: 'group:accessall',
        permission: 'PROHIBIT',
      },
    });
    invalidatePermissionCaches('roles');
    const [ga, gb] = [
      await t.db.group.create({ data: { courseId: f.courseId, name: 'А' } }),
      await t.db.group.create({ data: { courseId: f.courseId, name: 'Б' } }),
    ];
    await t.db.groupMember.createMany({
      data: [
        { groupId: ga.id, userId: f.users.assistant! },
        { groupId: ga.id, userId: f.users.student1! },
        { groupId: gb.id, userId: f.users.student2! },
      ],
    });
    const assistant = await ctxFor(t.db, f.users.assistant!);
    const [s1, s2] = [f.users.student1!, f.users.student2!];

    // the assignment
    const { id: assignId } = await f.addActivity(
      'assign',
      'Эссе',
      { gradeMax: 10 },
      { groupMode: 'SEPARATE' },
    );
    for (const u of [s1, s2])
      await runModuleAction(await ctxFor(t.db, u), assignId, 'saveSubmission', {
        text: '<p>Работа</p>',
        submit: true,
      });
    const assign = async () => {
      const a = await t.db.activity.findUniqueOrThrow({ where: { id: assignId } });
      return toActivityRef(a) as Parameters<typeof markedBy>[1];
    };
    expect(await markedBy(buildModuleCtx(assistant), await assign(), [s1, s2])).toEqual([s1]);
    expect(await markedBy(buildModuleCtx(teacher), await assign(), [s1, s2])).toEqual([s1, s2]);
    await expect(
      runModuleAction(assistant, assignId, 'grade', { userId: s2, grade: 5 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runModuleAction(assistant, assignId, 'grade', { userId: s1, grade: 5 });
    // nor reads the files of the other group's work, by their address
    const submissionOf = async (userId: string) =>
      (await t.db.assignSubmission.findFirstOrThrow({ where: { activityId: assignId, userId } }))
        .id;
    const readsFile = async (ctx: typeof teacher, userId: string) =>
      getModule('assign')!.files!.submission!.canRead(
        buildModuleCtx(ctx),
        (await assign()) as never,
        {
          itemId: await submissionOf(userId),
          uploadedById: userId,
        },
      );
    expect(await readsFile(assistant, s2)).toBe(false);
    expect(await readsFile(assistant, s1)).toBe(true);
    expect(await readsFile(teacher, s2)).toBe(true);

    // the quiz
    await importGift.run(teacher, { courseId: f.courseId, gift: '::Q1:: Земля круглая {T}' });
    const { id: quizId } = await f.addActivity(
      'quiz',
      'Тест',
      { gradeMax: 10 },
      { groupMode: 'SEPARATE' },
    );
    const q = await t.db.question.findFirstOrThrow({
      where: { category: { contextId: f.courseId } },
    });
    await runModuleAction(teacher, quizId, 'addQuestions', { questionIds: [q.id] });
    const attempts: Record<string, string> = {};
    for (const u of [s1, s2]) {
      const ctx = await ctxFor(t.db, u);
      const { attemptId } = (await runModuleAction(ctx, quizId, 'start', {})) as {
        attemptId: string;
      };
      await runModuleAction(ctx, quizId, 'finish', { attemptId });
      attempts[u] = attemptId;
    }
    const quiz = toActivityRef(await t.db.activity.findUniqueOrThrow({ where: { id: quizId } }));
    const seen = async (ctx: typeof teacher) =>
      (
        await t.db.quizAttempt.findMany({
          where: { activityId: quizId, ...(await attemptsSeenBy(buildModuleCtx(ctx), quiz)) },
          select: { userId: true },
        })
      ).map((x) => x.userId);
    expect(await seen(assistant)).toEqual([s1]);
    expect((await seen(teacher)).sort()).toEqual([s1, s2].sort());
    const review = (ctx: typeof teacher, userId: string) =>
      readReview(buildModuleCtx(ctx), quiz as Parameters<typeof readReview>[1], attempts[userId]!);
    expect(await review(assistant, s2)).toBeNull();
    expect(await review(assistant, s1)).not.toBeNull();
    // a regrade's report lists the attempts the teacher sees
    const regraded = (ctx: typeof teacher) =>
      regradeQuiz(buildModuleCtx(ctx), quiz as Parameters<typeof regradeQuiz>[1], true);
    expect((await regraded(assistant)).attempts.map((x) => x.userId)).toEqual([s1]);
    expect((await regraded(teacher)).attempts).toHaveLength(2);
  });
});
