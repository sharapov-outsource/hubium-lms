import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { getActivityAccess } from '../courses/activities.ts';
import { ForbiddenError } from '../errors.ts';
import { runModuleAction } from './actions.ts';

describe('mod-assign through the module action runner', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let assignId: string;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'ASSIGN1');
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const { id } = await f.addActivity(
      'assign',
      'Эссе',
      { dueAt: due, gradeMax: 20, gradePass: 10, reopen: 'untilpass', maxAttempts: 3 },
      {
        completionMode: 'AUTO',
        completionRules: { module: { submit: true } },
      },
    );
    assignId = id;
  });

  it('creates a grade item and a DUE calendar event', async () => {
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: assignId } });
    expect(Number(item.gradeMax)).toBe(20);
    expect(await t.db.calendarEvent.count({ where: { activityId: assignId, kind: 'DUE' } })).toBe(
      1,
    );
  });

  it('student saves a draft, then submits; completion follows the submit rule', async () => {
    const s1 = await ctxFor(t.db, 'student1@hubium.local');
    await runModuleAction(s1, assignId, 'saveSubmission', { text: '<p>Черновик</p>' });
    let sub = await t.db.assignSubmission.findFirstOrThrow({
      where: { activityId: assignId, userId: f.users.student1 },
    });
    expect(sub.status).toBe('DRAFT');
    await runModuleAction(s1, assignId, 'saveSubmission', {
      text: '<p>Готово</p><script>x</script>',
      submit: true,
      files: [{ name: 'essay.txt', mimeType: 'text/plain', data: Buffer.from('hello') }],
    });
    sub = await t.db.assignSubmission.findFirstOrThrow({
      where: { activityId: assignId, userId: f.users.student1 },
    });
    expect(sub.status).toBe('SUBMITTED');
    expect(sub.onlineText).toBe('<p>Готово</p>');
    expect(
      await t.db.file.count({ where: { contextId: assignId, area: 'submission', itemId: sub.id } }),
    ).toBe(1);
    const c = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: assignId, userId: f.users.student1! } },
    });
    expect(c.state).toBe('COMPLETE');
    await expect(
      runModuleAction(s1, assignId, 'saveSubmission', { text: 'again' }),
    ).rejects.toThrow(/Already submitted/);
  });

  it('an empty submission cannot be submitted', async () => {
    const s3 = await ctxFor(t.db, 'student3@hubium.local');
    await expect(
      runModuleAction(s3, assignId, 'saveSubmission', { text: '<p></p>', submit: true }),
    ).rejects.toThrow(/empty/);
  });

  it('students cannot grade; teachers grade into the gradebook', async () => {
    const s2 = await ctxFor(t.db, 'student2@hubium.local');
    await expect(
      runModuleAction(s2, assignId, 'grade', { userId: f.users.student1, grade: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    await expect(
      runModuleAction(teacher, assignId, 'grade', { userId: f.users.student1, grade: 25 }),
    ).rejects.toThrow(/between/);
    await runModuleAction(teacher, assignId, 'grade', {
      userId: f.users.student1,
      grade: 15,
      feedback: '<p>Хорошо</p>',
    });
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: assignId } });
    const g = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student1! } },
    });
    expect(Number(g.finalGrade)).toBe(15);
    const total = await t.db.gradeItem.findFirstOrThrow({
      where: { courseId: f.courseId, kind: 'COURSE' },
    });
    const tg = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: total.id, userId: f.users.student1! } },
    });
    expect(Number(tg.finalGrade)).toBeCloseTo(75);
  });

  it('a failing grade reopens a new attempt automatically (until pass)', async () => {
    const s2 = await ctxFor(t.db, 'student2@hubium.local');
    await runModuleAction(s2, assignId, 'saveSubmission', {
      text: '<p>Попытка 1</p>',
      submit: true,
    });
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    await runModuleAction(teacher, assignId, 'grade', { userId: f.users.student2, grade: 5 });
    const latest = await t.db.assignSubmission.findFirstOrThrow({
      where: { activityId: assignId, userId: f.users.student2, latest: true },
    });
    expect(latest.attemptNumber).toBe(1);
    expect(latest.status).toBe('REOPENED');
    expect(latest.onlineText).toBe('<p>Попытка 1</p>');
  });

  it('cut-off closes submissions; an extension reopens them for one student', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const { id } = await f.addActivity('assign', 'Закрытое', { dueAt: past, cutoffAt: past });
    const s3 = await ctxFor(t.db, 'student3@hubium.local');
    await expect(runModuleAction(s3, id, 'saveSubmission', { text: '<p>x</p>' })).rejects.toThrow(
      /closed/,
    );
    await runModuleAction(teacher, id, 'extend', {
      userId: f.users.student3,
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await runModuleAction(s3, id, 'saveSubmission', { text: '<p>x</p>', submit: true });
    const s2 = await ctxFor(t.db, 'student2@hubium.local');
    await expect(runModuleAction(s2, id, 'saveSubmission', { text: '<p>x</p>' })).rejects.toThrow(
      /closed/,
    );
  });

  it('submission files are readable by the owner and teachers only', async () => {
    const { canReadFile } = await import('../files/files.ts');
    const file = await t.db.file.findFirstOrThrow({
      where: { contextId: assignId, area: 'submission' },
    });
    expect(await canReadFile(await ctxFor(t.db, 'student1@hubium.local'), file)).toBe(true);
    expect(await canReadFile(await ctxFor(t.db, 'teacher@hubium.local'), file)).toBe(true);
    expect(await canReadFile(await ctxFor(t.db, 'student2@hubium.local'), file)).toBe(false);
  });

  it('teachers see "to grade" items; students see "to submit"', async () => {
    const { listModules } = await import('./registry.ts');
    const { buildModuleCtx } = await import('./module-ctx.ts');
    const assign = listModules().find((m) => m.key === 'assign')!;
    const s3 = await ctxFor(t.db, 'student3@hubium.local');
    const todo3 = await assign.todo!(buildModuleCtx(s3), f.users.student3!, [f.courseId]);
    expect(todo3.some((x) => x.activityId === assignId && x.kind === 'submit')).toBe(true);
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const todoT = await assign.todo!(buildModuleCtx(teacher), f.users.teacher!, [f.courseId]);
    expect(todoT.find((x) => x.kind === 'grade')?.count).toBeGreaterThanOrEqual(1);
    expect((await getActivityAccess(s3, assignId)).canOpen).toBe(true);
  });
});
