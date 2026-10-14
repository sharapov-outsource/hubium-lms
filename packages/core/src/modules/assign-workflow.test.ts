import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { enrolUsers } from '../enrol/enrol.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { listModules } from './registry.ts';

// Marking: grades reach students and the gradebook once released, the stages each role may
// set, markers allocated to students, and grades given with a rubric or a marking guide.

type Status = {
  grade: {
    value: number | null;
    form: { method: string; criteria: { id: string; levelId: string | null }[] } | null;
  } | null;
};

describe('assignment: marking workflow, allocation, rubrics', () => {
  const t = useTestDb();

  async function setup(code: string, settings: Record<string, unknown>) {
    const f = await courseFixture(t.db, code);
    // the assistant marks (a non-editing teacher): grades, but neither reviews nor releases
    const sys = await ctxFor(t.db, 'system');
    await enrolUsers.run(sys, {
      courseId: f.courseId,
      userIds: [f.users.assistant!],
      roleId: f.roles.teacher!,
    });
    const { id } = await f.addActivity('assign', 'Курсовая', { gradeMax: 10, ...settings });
    const [teacher, assistant, s1, s2] = await Promise.all(
      [f.users.teacher!, f.users.assistant!, f.users.student1!, f.users.student2!].map((u) =>
        ctxFor(t.db, u),
      ),
    );
    return { f, id, teacher: teacher!, assistant: assistant!, s1: s1!, s2: s2! };
  }
  const finalGrade = async (activityId: string, userId: string) => {
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId } });
    const g = await t.db.grade.findUnique({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
    });
    return g?.finalGrade === null || g?.finalGrade === undefined ? null : Number(g.finalGrade);
  };
  const notified = (userId: string, type: string, contextId: string) =>
    t.db.notification.count({ where: { userId, type, contextId } });

  it('grades reach the student and the gradebook once released', async () => {
    const { f, id, teacher, assistant, s1 } = await setup('AWF1', { markingWorkflow: true });
    const student = f.users.student1!;
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Работа</p>', submit: true });
    await runModuleAction(assistant, id, 'grade', { userId: student, grade: 8 });
    // marked, not released: nothing for the student or the gradebook yet
    expect(await finalGrade(id, student)).toBeNull();
    expect(((await runModuleQuery(s1, id, 'status', {})) as Status).grade).toBeNull();
    expect(await notified(student, 'assign.graded', id)).toBe(0);
    const flags = await t.db.assignUserFlags.findFirstOrThrow({
      where: { activityId: id, userId: student },
    });
    expect(flags.workflowState).toBe('INMARKING');

    // the marker hands over; releasing is not theirs
    await runModuleAction(assistant, id, 'setWorkflowState', {
      userIds: [student],
      state: 'READYFORREVIEW',
    });
    await expect(
      runModuleAction(assistant, id, 'setWorkflowState', { userIds: [student], state: 'RELEASED' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runModuleAction(teacher, id, 'setWorkflowState', {
      userIds: [student],
      state: 'RELEASED',
    });
    expect(await finalGrade(id, student)).toBe(8);
    expect(((await runModuleQuery(s1, id, 'status', {})) as Status).grade?.value).toBe(8);
    expect(await notified(student, 'assign.graded', id)).toBe(1);
    // a released grade goes back only with the right to release
    await expect(
      runModuleAction(assistant, id, 'setWorkflowState', {
        userIds: [student],
        state: 'INMARKING',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runModuleAction(teacher, id, 'setWorkflowState', {
      userIds: [student],
      state: 'INREVIEW',
    });
    expect(await finalGrade(id, student)).toBeNull();
  });

  it('markers see, grade and hear of the students allocated to them', async () => {
    const { f, id, teacher, assistant, s1, s2 } = await setup('AWF2', {
      markingWorkflow: true,
      markingAllocation: true,
    });
    await runModuleAction(teacher, id, 'allocateMarker', {
      userIds: [f.users.student1],
      markerId: f.users.assistant,
    });
    // only graders can mark, and only those who allocate allocate
    await expect(
      runModuleAction(teacher, id, 'allocateMarker', {
        userIds: [f.users.student2],
        markerId: f.users.student3,
      }),
    ).rejects.toThrow(/marker/);
    await expect(
      runModuleAction(assistant, id, 'allocateMarker', {
        userIds: [f.users.student2],
        markerId: f.users.assistant,
      }),
    ).rejects.toThrow();
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Один</p>', submit: true });
    await runModuleAction(s2, id, 'saveSubmission', { text: '<p>Два</p>', submit: true });
    // the allocated marker hears of student1's work, the others do not
    expect(await notified(f.users.assistant!, 'assign.submitted', id)).toBe(1);
    expect(await notified(f.users.teacher!, 'assign.submitted', id)).toBe(1);
    await expect(
      runModuleAction(assistant, id, 'grade', { userId: f.users.student2, grade: 5 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runModuleAction(assistant, id, 'grade', { userId: f.users.student1, grade: 7 });
    const assign = listModules().find((m) => m.key === 'assign')!;
    const [mine, all] = await Promise.all([
      assign.todo!(buildModuleCtx(assistant), f.users.assistant!, [f.courseId]),
      assign.todo!(buildModuleCtx(teacher), f.users.teacher!, [f.courseId]),
    ]);
    expect(mine.find((x) => x.activityId === id)).toBeUndefined();
    expect(all.find((x) => x.activityId === id)?.count).toBe(1);
  });

  it('a rubric gives the grade; a rubric in use keeps its criteria and levels', async () => {
    const { f, id, teacher, s1 } = await setup('AWF3', { gradingMethod: 'rubric' });
    const rubric = {
      criteria: [
        {
          id: 'c1',
          description: 'Структура',
          levels: [
            { id: 'a0', score: 0, definition: 'Нет' },
            { id: 'a1', score: 1, definition: 'Частично' },
            { id: 'a2', score: 2, definition: 'Ясная' },
          ],
        },
        {
          id: 'c2',
          description: 'Аргументы',
          levels: [
            { id: 'b0', score: 0, definition: 'Нет' },
            { id: 'b1', score: 2, definition: 'Есть' },
            { id: 'b2', score: 4, definition: 'Убедительные' },
          ],
        },
      ],
    };
    await runModuleAction(teacher, id, 'saveGradingDefinition', {
      method: 'rubric',
      definition: rubric,
    });
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Эссе</p>', submit: true });
    const student = f.users.student1!;
    // the grade comes from the rubric, never typed over it
    await expect(
      runModuleAction(teacher, id, 'grade', { userId: student, grade: 5 }),
    ).rejects.toThrow(/rubric/);
    await expect(
      runModuleAction(teacher, id, 'grade', {
        userId: student,
        grade: null,
        rubric: { c1: { levelId: 'a2' } },
      }),
    ).rejects.toThrow(/Аргументы/);
    await runModuleAction(teacher, id, 'grade', {
      userId: student,
      grade: null,
      rubric: { c1: { levelId: 'a2' }, c2: { levelId: 'b1', remark: 'Мало примеров' } },
    });
    // 4 of 6 points on 0..10
    expect(await finalGrade(id, student)).toBeCloseTo(6.66667, 4);
    const status = (await runModuleQuery(s1, id, 'status', {})) as Status;
    expect(status.grade?.form).toMatchObject({
      method: 'rubric',
      criteria: [
        { id: 'c1', levelId: 'a2' },
        { id: 'c2', levelId: 'b1', remark: 'Мало примеров' },
      ],
    });
    // texts and points may change, criteria and levels may not come or go
    rubric.criteria[0]!.levels[2]!.definition = 'Ясная и логичная';
    await runModuleAction(teacher, id, 'saveGradingDefinition', {
      method: 'rubric',
      definition: rubric,
    });
    await expect(
      runModuleAction(teacher, id, 'saveGradingDefinition', {
        method: 'rubric',
        definition: { criteria: [rubric.criteria[0]] },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // markers cannot define forms
    const assistant = await ctxFor(t.db, f.users.assistant!);
    await expect(
      runModuleAction(assistant, id, 'saveGradingDefinition', {
        method: 'rubric',
        definition: rubric,
      }),
    ).rejects.toThrow();
  });

  it('a marking guide gives the grade from the scores', async () => {
    const { f, id, teacher, s1 } = await setup('AWF4', { gradingMethod: 'guide' });
    await runModuleAction(teacher, id, 'saveGradingDefinition', {
      method: 'guide',
      definition: {
        criteria: [
          { id: 'g1', shortName: 'Содержание', maxScore: 5 },
          { id: 'g2', shortName: 'Оформление', maxScore: 5, descriptionMarkers: 'Только ГОСТ' },
        ],
      },
    });
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Отчёт</p>', submit: true });
    const student = f.users.student1!;
    await expect(
      runModuleAction(teacher, id, 'grade', {
        userId: student,
        grade: null,
        guide: { g1: { score: 6 }, g2: { score: 1 } },
      }),
    ).rejects.toThrow(/Содержание/);
    await runModuleAction(teacher, id, 'grade', {
      userId: student,
      grade: null,
      guide: { g1: { score: 3 }, g2: { score: 4, remark: 'Аккуратно' } },
    });
    expect(await finalGrade(id, student)).toBe(7);
    // the notes for markers stay with the markers
    const status = (await runModuleQuery(s1, id, 'status', {})) as Status;
    expect(JSON.stringify(status.grade?.form)).not.toContain('ГОСТ');
  });

  it('turning the workflow on keeps grades given before it released', async () => {
    const { f, id, teacher, s1 } = await setup('AWF5', {});
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Работа</p>', submit: true });
    await runModuleAction(teacher, id, 'grade', { userId: f.users.student1, grade: 9 });
    const { updateActivity } = await import('../courses/activities.ts');
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    await updateActivity.run(teacher, {
      id,
      name: act.name,
      settings: { ...(act.settings as object), markingWorkflow: true },
    });
    expect(await finalGrade(id, f.users.student1!)).toBe(9);
    const flags = await t.db.assignUserFlags.findFirstOrThrow({
      where: { activityId: id, userId: f.users.student1 },
    });
    expect(flags.workflowState).toBe('RELEASED');
  });
});
