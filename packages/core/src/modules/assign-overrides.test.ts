import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import type { RequestContext } from '../context.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

// Assignment dates for students and groups (the student's own first, then the group with
// the highest priority), and the late penalty they decide in the gradebook.

const DAY = 86_400_000;

describe('assignment: dates for students and groups, late penalty', () => {
  const t = useTestDb();

  async function setup(code: string, settings: Record<string, unknown> = {}) {
    const f = await courseFixture(t.db, code);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const now = Date.now();
    const { id } = await f.addActivity('assign', 'Эссе', {
      dueAt: new Date(now - 3 * DAY + 3600_000).toISOString(),
      gradeMax: 100,
      latePenaltyPerDay: 10,
      latePenaltyCap: 25,
      ...settings,
    });
    const [g1, g2] = await Promise.all(
      ['Поток А', 'Поток Б'].map((name) =>
        t.db.group.create({ data: { courseId: f.courseId, name } }),
      ),
    );
    await t.db.groupMember.createMany({
      data: [
        { groupId: g1!.id, userId: f.users.student1! },
        { groupId: g2!.id, userId: f.users.student1! },
        { groupId: g2!.id, userId: f.users.student2! },
      ],
    });
    return { f, teacher, id, g1: g1!, g2: g2!, now };
  }
  const dueOf = async (ctx: RequestContext, id: string) => {
    const { dates } = (await runModuleQuery(ctx, id, 'status', {})) as {
      dates: { dueAt: Date | null; source: string | null; extended: boolean };
    };
    return {
      dueAt: dates.dueAt?.toISOString() ?? null,
      source: dates.source,
      extended: dates.extended,
    };
  };
  const finalGrade = async (activityId: string, userId: string) => {
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId } });
    const g = await t.db.grade.findUnique({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
    });
    return g?.finalGrade === null || g?.finalGrade === undefined ? null : Number(g.finalGrade);
  };

  it('a student’s own dates, then their highest group’s, then the assignment’s', async () => {
    const { f, teacher, id, g1, g2, now } = await setup('AOV1');
    const s1 = await ctxFor(t.db, f.users.student1!);
    const s2 = await ctxFor(t.db, f.users.student2!);
    const at = (days: number) => new Date(now + days * DAY).toISOString();
    await runModuleAction(teacher, id, 'setOverride', { groupId: g1.id, dueAt: at(1) });
    await runModuleAction(teacher, id, 'setOverride', { groupId: g2.id, dueAt: at(2) });
    // student1 is in both groups: the first one added is the highest
    expect(await dueOf(s1, id)).toEqual({ dueAt: at(1), source: 'group', extended: true });
    expect((await dueOf(s2, id)).dueAt).toBe(at(2));
    const [first] = await t.db.assignOverride.findMany({
      where: { activityId: id, groupId: g1.id },
    });
    await runModuleAction(teacher, id, 'moveOverride', { id: first!.id, direction: 'down' });
    expect((await dueOf(s1, id)).dueAt).toBe(at(2));
    // their own dates come first
    await runModuleAction(teacher, id, 'setOverride', { userId: f.users.student1, dueAt: at(5) });
    expect(await dueOf(s1, id)).toMatchObject({ dueAt: at(5), source: 'user' });
    // students cannot manage dates; the cut-off cannot come before the due date
    await expect(
      runModuleAction(s1, id, 'setOverride', { userId: f.users.student1, dueAt: at(9) }),
    ).rejects.toThrow();
    await expect(
      runModuleAction(teacher, id, 'setOverride', {
        groupId: g1.id,
        dueAt: at(3),
        cutoffAt: at(2),
      }),
    ).rejects.toThrow(/Cut-off/);
  });

  it('takes a penalty for every started day late, up to the cap, and follows date changes', async () => {
    const { f, teacher, id, g2, now } = await setup('AOV2');
    const s2 = await ctxFor(t.db, f.users.student2!);
    // due 3 days less an hour ago: submitted now, 3 started days late → 30%, capped at 25%
    const status = (await runModuleQuery(s2, id, 'status', {})) as { late: { penalty: number } };
    expect(status.late.penalty).toBe(25);
    await runModuleAction(s2, id, 'saveSubmission', { text: '<p>Поздно</p>', submit: true });
    await runModuleAction(teacher, id, 'grade', { userId: f.users.student2, grade: 80 });
    expect(await finalGrade(id, f.users.student2!)).toBe(60);
    const graded = (await runModuleQuery(s2, id, 'status', {})) as {
      grade: { value: number; penalty: number; final: number };
    };
    expect(graded.grade).toMatchObject({ value: 80, penalty: 25, final: 60 });
    // new dates for the group: two started days late → 20%
    await runModuleAction(teacher, id, 'setOverride', {
      groupId: g2.id,
      dueAt: new Date(now - DAY - 3600_000).toISOString(),
    });
    expect(await finalGrade(id, f.users.student2!)).toBe(64);
    // the group's dates go: back to the assignment's
    const o = await t.db.assignOverride.findFirstOrThrow({
      where: { activityId: id, groupId: g2.id },
    });
    await runModuleAction(teacher, id, 'deleteOverride', { id: o.id });
    expect(await finalGrade(id, f.users.student2!)).toBe(60);
    // an extension past the submission: on time, no penalty
    await runModuleAction(teacher, id, 'extend', {
      userId: f.users.student2,
      dueAt: new Date(now + DAY).toISOString(),
    });
    expect(await finalGrade(id, f.users.student2!)).toBe(80);
  });

  it('no penalty for grades on a scale', async () => {
    const f = await courseFixture(t.db, 'AOV3');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const scale = await t.db.scale.create({
      data: { courseId: f.courseId, name: 'Зачёт', items: ['Не зачтено', 'Зачтено'] },
    });
    const { id } = await f.addActivity('assign', 'Зачёт', {
      dueAt: new Date(Date.now() - 2 * DAY).toISOString(),
      scaleId: scale.id,
      latePenaltyPerDay: 50,
    });
    const s1 = await ctxFor(t.db, f.users.student1!);
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Ответ</p>', submit: true });
    await runModuleAction(teacher, id, 'grade', { userId: f.users.student1, grade: 2 });
    expect(await finalGrade(id, f.users.student1!)).toBe(2);
  });

  it('an extension takes the dates and checks of an override, and leaves the rest', async () => {
    const { f, teacher, id, now } = await setup('AOV4');
    const s1 = f.users.student1!;
    const extend = (input: Record<string, unknown>) =>
      runModuleAction(teacher, id, 'extend', { userId: s1, ...input });
    // a wrong date is a mistake of the form, not of the server
    await expect(extend({ dueAt: 'завтра' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      extend({
        dueAt: new Date(now + 2 * DAY).toISOString(),
        cutoffAt: new Date(now + DAY).toISOString(),
      }),
    ).rejects.toThrow(/Cut-off/);
    const outsider = await t.db.user.findFirstOrThrow({ where: { username: 'manager' } });
    await expect(
      runModuleAction(teacher, id, 'extend', {
        userId: outsider.id,
        dueAt: new Date(now + DAY).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // their own opening date stays when the extension is taken back
    const from = new Date(now + 3600_000).toISOString();
    await runModuleAction(teacher, id, 'setOverride', { userId: s1, allowSubmissionsFrom: from });
    await extend({ dueAt: new Date(now + DAY).toISOString() });
    await extend({ dueAt: null });
    const own = await t.db.assignOverride.findUniqueOrThrow({
      where: { activityId_userId: { activityId: id, userId: s1 } },
    });
    expect(own).toMatchObject({ dueAt: null, cutoffAt: null });
    expect(own.allowSubmissionsFrom?.toISOString()).toBe(from);
  });
});
