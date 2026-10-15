import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { resetCourse } from '../courses/reset.ts';
import { importGift } from '../questions/bank.ts';
import { runModuleAction } from './actions.ts';

describe('grading settings changed after grades were given', () => {
  const t = useTestDb();
  const gradeOf = async (activityId: string, userId: string) => {
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId, itemNumber: 0 } });
    const g = await t.db.grade.findUnique({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
    });
    return g?.finalGrade == null ? null : Number(g.finalGrade);
  };
  const edit = async (
    ctx: Awaited<ReturnType<typeof ctxFor>>,
    id: string,
    settings: Record<string, unknown>,
  ) => {
    const a = await t.db.activity.findUniqueOrThrow({ where: { id } });
    await updateActivity.run(ctx, {
      id,
      name: a.name,
      settings: { ...(a.settings as object), ...settings },
    });
  };

  it('a quiz works its grades out again for a new maximum or grading method', async () => {
    const f = await courseFixture(t.db, 'GSQUIZ');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await importGift.run(teacher, { courseId: f.courseId, gift: '::Q1:: Земля круглая {T}' });
    const { id } = await f.addActivity('quiz', 'Тест', { attempts: 2, gradeMax: 10 });
    const q = await t.db.question.findFirstOrThrow({
      where: { category: { contextId: f.courseId } },
    });
    await runModuleAction(teacher, id, 'addQuestions', { questionIds: [q.id] });
    const attempt = async (userId: string, value: boolean) => {
      const s = await ctxFor(t.db, userId);
      const { attemptId } = (await runModuleAction(s, id, 'start', {})) as { attemptId: string };
      const [qa] = await t.db.questionAttempt.findMany({ where: { attemptId } });
      await runModuleAction(s, id, 'finish', { attemptId, answers: { [qa!.slot]: { value } } });
    };
    await attempt(f.users.student1!, true);
    await attempt(f.users.student2!, false);
    await attempt(f.users.student2!, true);
    expect(await gradeOf(id, f.users.student1!)).toBe(10);
    expect(await gradeOf(id, f.users.student2!)).toBe(10);

    await edit(teacher, id, { gradeMax: 100 });
    expect(await gradeOf(id, f.users.student1!)).toBe(100);
    await edit(teacher, id, { gradeMethod: 'FIRST' });
    expect(await gradeOf(id, f.users.student2!)).toBe(0);
  });

  it('an assignment applies a corrected due date and late penalty to the grades given', async () => {
    const f = await courseFixture(t.db, 'GSASSIGN');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
    const { id } = await f.addActivity('assign', 'Эссе', {
      gradeMax: 10,
      dueAt: hours(-12),
      latePenaltyPerDay: 25,
    });
    await runModuleAction(await ctxFor(t.db, f.users.student1!), id, 'saveSubmission', {
      text: '<p>Работа</p>',
      submit: true,
    });
    await runModuleAction(teacher, id, 'grade', { userId: f.users.student1, grade: 8 });
    expect(await gradeOf(id, f.users.student1!)).toBe(6);
    // the date was wrong: the work was on time
    await edit(teacher, id, { dueAt: hours(24) });
    expect(await gradeOf(id, f.users.student1!)).toBe(8);
    await edit(teacher, id, { dueAt: hours(-12), latePenaltyPerDay: 50 });
    expect(await gradeOf(id, f.users.student1!)).toBe(4);
  });

  it('a course reset moving the dates moves the late penalties with them', async () => {
    const f = await courseFixture(t.db, 'GSRESET');
    const admin = await ctxFor(t.db, 'admin@test.local');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const start = new Date(Date.now() - 30 * 86_400_000);
    await t.db.course.update({ where: { id: f.courseId }, data: { startDate: start } });
    const { id } = await f.addActivity('assign', 'Эссе', {
      gradeMax: 10,
      dueAt: new Date(Date.now() - 12 * 3_600_000).toISOString(),
      latePenaltyPerDay: 25,
    });
    await runModuleAction(await ctxFor(t.db, f.users.student1!), id, 'saveSubmission', {
      text: '<p>Работа</p>',
      submit: true,
    });
    await runModuleAction(teacher, id, 'grade', { userId: f.users.student1, grade: 8 });
    expect(await gradeOf(id, f.users.student1!)).toBe(6);
    // two days later: the work was in on time
    await resetCourse.run(admin, {
      courseId: f.courseId,
      startDate: new Date(start.getTime() + 2 * 86_400_000).toISOString(),
    });
    expect(await gradeOf(id, f.users.student1!)).toBe(8);
  });
});
