import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import type { RequestContext } from '../context.ts';
import { canReadFile } from '../files/files.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

// Team submissions: a group's one piece of work, every member's "submit" when asked for,
// students in no group or in several, and grading the whole team alike.

type Status = {
  status: string;
  editable: boolean;
  waitingForTeam: boolean;
  blocked: string | null;
  team: { name: string; members: { id: string; submitted: boolean }[] } | null;
  submission: { onlineText: string } | null;
};

describe('assignment: team submissions', () => {
  const t = useTestDb();

  async function setup(code: string, settings: Record<string, unknown> = {}) {
    const f = await courseFixture(t.db, code);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id } = await f.addActivity('assign', 'Проект', { teamSubmission: true, ...settings });
    const team = await t.db.group.create({ data: { courseId: f.courseId, name: 'Команда А' } });
    await t.db.groupMember.createMany({
      data: [
        { groupId: team.id, userId: f.users.student1! },
        { groupId: team.id, userId: f.users.student2! },
      ],
    });
    const [s1, s2, s3] = await Promise.all(
      [f.users.student1!, f.users.student2!, f.users.student3!].map((u) => ctxFor(t.db, u)),
    );
    const status = async (ctx: RequestContext) =>
      (await runModuleQuery(ctx, id, 'status', {})) as Status;
    return { f, teacher, id, team, s1: s1!, s2: s2!, s3: s3!, status };
  }

  it('one piece of work for the team, graded alike; no group means alone', async () => {
    const { f, teacher, id, team, s1, s2, s3, status } = await setup('ATM1');
    await runModuleAction(s1, id, 'saveSubmission', {
      text: '<p>Наш проект</p>',
      files: [{ name: 'plan.txt', mimeType: 'text/plain', data: Buffer.from('plan') }],
    });
    // the teammate sees and continues the same work
    const seen = await status(s2);
    expect(seen).toMatchObject({
      team: { name: 'Команда А' },
      submission: { onlineText: '<p>Наш проект</p>' },
    });
    const sub = await t.db.assignSubmission.findFirstOrThrow({ where: { activityId: id } });
    expect(sub).toMatchObject({ groupId: team.id, userId: null });
    const file = await t.db.file.findFirstOrThrow({ where: { contextId: id, area: 'submission' } });
    expect(await canReadFile(s2, file)).toBe(true);
    expect(await canReadFile(s3, file)).toBe(false);
    await runModuleAction(s2, id, 'saveSubmission', {
      text: '<p>Наш проект, готово</p>',
      submit: true,
    });
    expect((await status(s1)).status).toBe('SUBMITTED');

    // a student in no group submits alone
    await runModuleAction(s3, id, 'saveSubmission', { text: '<p>Один</p>', submit: true });
    expect(
      await t.db.assignSubmission.findFirst({
        where: { activityId: id, userId: f.users.student3 },
      }),
    ).toMatchObject({ status: 'SUBMITTED', groupId: null });

    // the whole team graded alike
    await runModuleAction(teacher, id, 'grade', {
      userId: f.users.student1,
      grade: 90,
      feedback: '<p>Хорошо</p>',
      applyToTeam: true,
    });
    const grades = await t.db.assignGrade.findMany({
      where: { activityId: id },
      orderBy: { userId: 'asc' },
    });
    expect(grades.map((g) => [g.userId, Number(g.grade)]).sort()).toEqual(
      [
        [f.users.student1, 90],
        [f.users.student2, 90],
      ].sort(),
    );
    // the teacher's list of what to grade counts the team once and the lone student once
    const { listModules } = await import('./registry.ts');
    const { buildModuleCtx } = await import('./module-ctx.ts');
    const todo = await listModules().find((m) => m.key === 'assign')!.todo!(
      buildModuleCtx(teacher),
      f.users.teacher!,
      [f.courseId],
    );
    expect(todo.find((x) => x.activityId === id)?.count).toBe(1);
  });

  it('blocks students in no group when asked, and students in several groups', async () => {
    const { f, id, s3, status } = await setup('ATM2', { preventSubmissionNotInGroup: true });
    expect(await status(s3)).toMatchObject({ blocked: 'noGroup', editable: false });
    await expect(
      runModuleAction(s3, id, 'saveSubmission', { text: '<p>?</p>' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const other = await t.db.group.create({ data: { courseId: f.courseId, name: 'Команда Б' } });
    await t.db.groupMember.create({ data: { groupId: other.id, userId: f.users.student1! } });
    const s1 = await ctxFor(t.db, f.users.student1!);
    expect((await status(s1)).blocked).toBe('severalGroups');
  });

  it('when every member must submit, the work goes in with the last one', async () => {
    const { id, s1, s2, status } = await setup('ATM3', { requireAllTeamMembers: true });
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Версия 1</p>', submit: true });
    expect(await status(s1)).toMatchObject({
      status: 'DRAFT',
      waitingForTeam: true,
      editable: false,
    });
    // a change by the other member asks the first again
    await runModuleAction(s2, id, 'saveSubmission', { text: '<p>Версия 2</p>' });
    expect((await status(s1)).waitingForTeam).toBe(false);
    await runModuleAction(s2, id, 'saveSubmission', { text: '<p>Версия 2</p>', submit: true });
    expect((await status(s2)).status).toBe('DRAFT');
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Версия 2</p>', submit: true });
    const done = await status(s1);
    expect(done.status).toBe('SUBMITTED');
    expect(done.team!.members.every((m) => m.submitted)).toBe(true);
    // taken back: everyone submits again
    await runModuleAction(s1, id, 'revertToDraft', {});
    expect((await status(s2)).team!.members.some((m) => m.submitted)).toBe(false);
  });

  it('asks for the statement of authorship before submitting', async () => {
    const { id, s1 } = await setup('ATM4', { requireStatement: true, teamSubmission: false });
    await expect(
      runModuleAction(s1, id, 'saveSubmission', { text: '<p>Сам</p>', submit: true }),
    ).rejects.toThrow(/statement/);
    await runModuleAction(s1, id, 'saveSubmission', {
      text: '<p>Сам</p>',
      submit: true,
      statement: true,
    });
    const sub = await t.db.assignSubmission.findFirstOrThrow({ where: { activityId: id } });
    expect(sub.statementAcceptedAt).not.toBeNull();
  });
});
