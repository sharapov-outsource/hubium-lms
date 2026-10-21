import { hidesNames, participantNumbers } from '@hubium/mod-assign/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { enrolUsers } from '../enrol/enrol.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';
import { buildModuleCtx, toActivityRef } from './module-ctx.ts';

// Blind marking: markers learn participant numbers, never names, and grades reach students
// and the gradebook only once identities are revealed (which cannot be undone).

describe('assignment: blind marking', () => {
  const t = useTestDb();

  it('hides names until identities are revealed, then releases the grades', async () => {
    const f = await courseFixture(t.db, 'ABL1');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const s1 = await ctxFor(t.db, f.users.student1!);
    const { id } = await f.addActivity('assign', 'Анонимное эссе', {
      gradeMax: 10,
      blindMarking: true,
    });
    const student = await t.db.user.findUniqueOrThrow({ where: { id: f.users.student1 } });
    await runModuleAction(s1, id, 'saveSubmission', { text: '<p>Моё эссе</p>', submit: true });

    // the marker hears of a participant number, not of the student
    const [note] = await t.db.notification.findMany({
      where: { userId: f.users.teacher, type: 'assign.submitted' },
    });
    const ref = toActivityRef(await t.db.activity.findUniqueOrThrow({ where: { id } }));
    const numbers = await participantNumbers(t.db, id, [student.id]);
    const number = numbers.get(student.id)!;
    expect(number).toBeGreaterThanOrEqual(100_000);
    expect(JSON.stringify(note)).toContain(String(number));
    for (const s of [student.name, student.firstName, student.lastName, student.username])
      if (s) expect(JSON.stringify(note)).not.toContain(s);
    // the number stays the same
    expect((await participantNumbers(t.db, id, [student.id])).get(student.id)).toBe(number);

    // teachers see numbers; managers may see who is who
    const manager = await ctxFor(t.db, f.users.manager!);
    expect(await hidesNames(buildModuleCtx(teacher), ref as never)).toBe(true);
    expect(await hidesNames(buildModuleCtx(manager), ref as never)).toBe(false);

    // graded blind: nothing reaches the student or the gradebook
    await runModuleAction(teacher, id, 'grade', { userId: student.id, grade: 6 });
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: id } });
    const gradebook = async () =>
      (
        await t.db.grade.findUnique({
          where: { gradeItemId_userId: { gradeItemId: item.id, userId: student.id } },
        })
      )?.finalGrade ?? null;
    expect(await gradebook()).toBeNull();
    expect(((await runModuleQuery(s1, id, 'status', {})) as { grade: unknown }).grade).toBeNull();
    expect(
      await t.db.notification.count({ where: { userId: student.id, type: 'assign.graded' } }),
    ).toBe(0);

    // blind marking cannot be switched off once the work is in
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    await expect(
      updateActivity.run(teacher, {
        id,
        name: act.name,
        settings: { ...(act.settings as object), blindMarking: false },
      }),
    ).rejects.toThrow(/Blind marking/);

    // revealing takes the right to; then the grade goes out
    const s2 = await ctxFor(t.db, f.users.student2!);
    await expect(runModuleAction(s2, id, 'revealIdentities', {})).rejects.toThrow();
    await runModuleAction(teacher, id, 'revealIdentities', {});
    expect(Number(await gradebook())).toBe(6);
    expect(
      ((await runModuleQuery(s1, id, 'status', {})) as { grade: { value: number } }).grade.value,
    ).toBe(6);
    expect(
      await t.db.notification.count({ where: { userId: student.id, type: 'assign.graded' } }),
    ).toBe(1);
    const revealed = toActivityRef(await t.db.activity.findUniqueOrThrow({ where: { id } }));
    expect(await hidesNames(buildModuleCtx(teacher), revealed as never)).toBe(false);
  });

  it('gives the numbers in operations, every student a different one', async () => {
    const f = await courseFixture(t.db, 'ABL2');
    const sys = await ctxFor(t.db, 'system');
    const ids = [f.users.student1!, f.users.student2!, f.users.student3!];
    // marked blind from the start: everyone in the course has a number
    const { id } = await f.addActivity('assign', 'Эссе', { blindMarking: true });
    const numbers = await participantNumbers(t.db, id, ids);
    expect(new Set(ids.map((u) => numbers.get(u))).size).toBe(3);
    // as has whoever is enrolled later
    await enrolUsers.run(sys, {
      courseId: f.courseId,
      userIds: [f.users.parent!],
      roleId: f.roles.student!,
    });
    const later = (await participantNumbers(t.db, id, [f.users.parent!])).get(f.users.parent!);
    expect(later).toBeGreaterThanOrEqual(100_000);
    expect([...numbers.values()]).not.toContain(later);

    // marked blind later: the numbers come then
    const { id: other } = await f.addActivity('assign', 'Реферат', {});
    expect((await participantNumbers(t.db, other, ids)).size).toBe(0);
    const act = await t.db.activity.findUniqueOrThrow({ where: { id: other } });
    await updateActivity.run(sys, {
      id: other,
      name: act.name,
      settings: { ...(act.settings as object), blindMarking: true },
    });
    expect((await participantNumbers(t.db, other, ids)).size).toBe(3);
  });
});
