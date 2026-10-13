import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { loadAvailabilityFacts, updateActivity } from '../courses/activities.ts';
import { evaluateAvailability } from '../courses/availability.ts';
import { updateCourse } from '../courses/courses.ts';
import { ValidationError } from '../errors.ts';
import {
  createGroup,
  createGrouping,
  deleteGrouping,
  listGroupings,
  setGroupingGroups,
  setGroupMembers,
} from './groups.ts';

describe('groupings', () => {
  const t = useTestDb();

  async function setup(code: string) {
    const f = await courseFixture(t.db, code);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const a = await createGroup.run(teacher, { courseId: f.courseId, name: 'A' });
    const b = await createGroup.run(teacher, { courseId: f.courseId, name: 'B' });
    await setGroupMembers.run(teacher, { groupId: a.id, add: [f.users.student1!] });
    await setGroupMembers.run(teacher, { groupId: b.id, add: [f.users.student2!] });
    const g = await createGrouping.run(teacher, { courseId: f.courseId, name: 'Stream 1' });
    await setGroupingGroups.run(teacher, { groupingId: g.id, groupIds: [a.id] });
    return { f, teacher, a, b, g };
  }

  it('groups sets of groups and limits access to their members', async () => {
    const { f, teacher, a, b, g } = await setup('GRP1');
    const listed = await listGroupings(teacher, f.courseId);
    expect(listed).toMatchObject([{ name: 'Stream 1', groups: [{ groupId: a.id }] }]);

    // a group of another course cannot join
    const other = await setup('GRP1B');
    await expect(
      setGroupingGroups.run(teacher, { groupingId: g.id, groupIds: [a.id, other.a.id] }),
    ).rejects.toBeInstanceOf(ValidationError);

    const tree = { op: '&' as const, c: [{ type: 'grouping' as const, groupingId: g.id }] };
    const facts = (userId: string) => loadAvailabilityFacts(teacher, f.courseId, userId);
    expect(evaluateAvailability(tree, await facts(f.users.student1!)).available).toBe(true);
    expect(evaluateAvailability(tree, await facts(f.users.student2!)).available).toBe(false);

    await setGroupingGroups.run(teacher, { groupingId: g.id, groupIds: [b.id] });
    expect(evaluateAvailability(tree, await facts(f.users.student2!)).available).toBe(true);
    expect(evaluateAvailability(tree, await facts(f.users.student1!)).available).toBe(false);
  });

  it('limits an activity to a grouping of its own course and frees it when deleted', async () => {
    const { f, teacher, g } = await setup('GRP2');
    const other = await setup('GRP2B');
    const forum = await f.addActivity('forum', 'Talk', {});
    const base = {
      id: forum.id,
      name: 'Talk',
      groupMode: 'SEPARATE' as const,
      settings: {},
    };
    await expect(
      updateActivity.run(teacher, { ...base, groupingId: other.g.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await updateActivity.run(teacher, { ...base, groupingId: g.id });
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: forum.id } })).groupingId).toBe(
      g.id,
    );
    await deleteGrouping.run(teacher, { id: g.id });
    expect(
      (await t.db.activity.findUniqueOrThrow({ where: { id: forum.id } })).groupingId,
    ).toBeNull();
  });

  it("applies the course's forced group mode to its activities", async () => {
    const f = await courseFixture(t.db, 'GRP3');
    const forum = await f.addActivity('forum', 'Talk', {});
    const admin = await ctxFor(t.db, 'admin@test.local');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    await updateCourse.run(admin, {
      id: course.id,
      categoryId: course.categoryId,
      fullName: course.fullName,
      shortName: course.shortName,
      groupMode: 'SEPARATE',
      groupModeForced: true,
    });
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: forum.id } })).groupMode).toBe(
      'SEPARATE',
    );
    // and an activity cannot leave it while it is forced
    await updateActivity.run(admin, {
      id: forum.id,
      name: 'Talk',
      groupMode: 'NONE',
      settings: {},
    });
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: forum.id } })).groupMode).toBe(
      'SEPARATE',
    );
  });
});
