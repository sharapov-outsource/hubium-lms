import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError } from '../errors.ts';
import { userReport } from '../grades/gradebook.ts';
import { runModuleAction } from '../modules/actions.ts';
import { exportUserData } from '../privacy/privacy.ts';
import { setSettings } from '../settings/settings.ts';
import {
  addUserRelation,
  bulkUploadUserRelations,
  canViewUserData,
  hasMentees,
  listMentees,
  listMentorsOf,
  menteeOverview,
  removeUserRelation,
  userRelations,
} from './relations.ts';
import { createUser, deleteUser, setUserSuspended } from './users.ts';

describe('mentors and parents', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let parentId: string;
  let assignId: string;
  const as = (id: string) => ctxFor(t.db, id);
  const admin = () => ctxFor(t.db, 'admin@test.local');
  const enable = (on: boolean) => setSettings(t.db, { 'mentors.enabled': on });

  beforeAll(async () => {
    f = await courseFixture(t.db, 'MENTORS');
    parentId = (
      await createUser.run(await admin(), {
        username: 'parent1',
        email: 'parent1@test.local',
        firstName: 'Мария',
        lastName: 'Родителева',
        password: 'Password123',
      })
    ).id;
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    assignId = (await f.addActivity('assign', 'Сочинение', { dueAt: due, gradeMax: 10 })).id;
    await addUserRelation.run(await admin(), {
      mentorId: parentId,
      menteeId: f.users.student1!,
      kind: 'PARENT',
    });
  });

  it('shows nothing while the site has the feature off', async () => {
    await enable(false);
    const parent = await as(parentId);
    expect(await canViewUserData(parent, f.users.student1!, 'overview')).toBe(false);
    expect(await listMentees(parent)).toEqual([]);
    expect(await hasMentees(t.db, parentId)).toBe(false);
    await expect(menteeOverview(parent, f.users.student1!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(userReport(parent, f.courseId, f.users.student1!)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("lets a mentor follow the mentee's courses, deadlines and grades", async () => {
    await enable(true);
    try {
      const parent = await as(parentId);
      expect(await listMentees(parent)).toEqual([
        expect.objectContaining({ id: f.users.student1, kind: 'PARENT' }),
      ]);
      // (the demo data gives student1 a parent of their own as well)
      expect(await listMentorsOf(t.db, f.users.student1!)).toContainEqual(
        expect.objectContaining({ id: parentId, kind: 'PARENT' }),
      );
      const o = await menteeOverview(parent, f.users.student1!);
      expect(o.courses.map((c) => c.id)).toContain(f.courseId);
      // the deadline is the mentee's: the parent cannot submit anything themselves
      expect(o.todo).toEqual([expect.objectContaining({ activityId: assignId, kind: 'submit' })]);

      await runModuleAction(await as(f.users.teacher!), assignId, 'grade', {
        userId: f.users.student1!,
        grade: 7,
      });
      const r = await userReport(parent, f.courseId, f.users.student1!);
      const item = [...r.items].find((i) => i.activityId === assignId)!;
      expect(Number(r.grades.get(item.id)?.finalGrade)).toBe(7);
      // what the learner may not see stays hidden from the parent too
      await t.db.gradeItem.update({ where: { id: item.id }, data: { hidden: true } });
      const hidden = await userReport(parent, f.courseId, f.users.student1!);
      expect(hidden.items.some((i) => i.id === item.id)).toBe(false);
      await t.db.gradeItem.update({ where: { id: item.id }, data: { hidden: false } });

      // nobody else's data, and nothing for other users
      expect(await canViewUserData(parent, f.users.student2!, 'overview')).toBe(false);
      await expect(userReport(parent, f.courseId, f.users.student2!)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      const other = await as(f.users.student2!);
      await expect(menteeOverview(other, f.users.student1!)).rejects.toBeInstanceOf(ForbiddenError);

      // a suspended mentee is no longer followed
      await setUserSuspended.run(await admin(), { id: f.users.student1!, suspended: true });
      expect(await canViewUserData(parent, f.users.student1!, 'overview')).toBe(false);
      await setUserSuspended.run(await admin(), { id: f.users.student1!, suspended: false });
    } finally {
      await enable(false);
    }
  });

  it('links and unlinks from CSV, line by line, and logs the changes', async () => {
    const csv = [
      'mentor,mentee,kind,action',
      'parent1,student2,parent,',
      'parent1@test.local,student3,mentor,add',
      'nobody,student2,,',
      'parent1,student2,uncle,add',
      'parent1,student3,,remove',
    ].join('\n');
    const r = await bulkUploadUserRelations.run(await admin(), { csv });
    expect(r).toMatchObject({ added: 2, removed: 1 });
    expect(r.errors).toEqual([
      { line: 4, message: 'Unknown mentor "nobody"' },
      { line: 5, message: 'Unknown kind "uncle"' },
    ]);
    const card = await userRelations(await admin(), parentId);
    expect(card.mentees.map((m) => m.id).sort()).toEqual(
      [f.users.student1!, f.users.student2!].sort(),
    );
    expect(
      await t.db.eventLog.count({
        where: { name: 'user.relation.added', relatedUserId: f.users.student2 },
      }),
    ).toBe(1);
    expect(
      await t.db.eventLog.count({
        where: { name: 'user.relation.removed', relatedUserId: f.users.student3 },
      }),
    ).toBe(1);
    await expect(
      addUserRelation.run(await as(f.users.teacher!), {
        mentorId: f.users.teacher!,
        menteeId: f.users.student3!,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      addUserRelation.run(await admin(), { mentorId: parentId, menteeId: parentId }),
    ).rejects.toThrow();
    await removeUserRelation.run(await admin(), {
      mentorId: parentId,
      menteeId: f.users.student2!,
    });
  });

  it('exports relations and removes them with the account', async () => {
    const data = (await exportUserData(await admin(), parentId)) as {
      mentees: { name: string; kind: string }[];
    };
    expect(data.mentees).toEqual([expect.objectContaining({ kind: 'PARENT' })]);
    await deleteUser.run(await admin(), { id: parentId });
    expect(await t.db.userRelation.count({ where: { mentorId: parentId } })).toBe(0);
  });
});
