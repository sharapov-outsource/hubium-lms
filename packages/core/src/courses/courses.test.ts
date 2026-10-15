import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { createEvent, listUserEvents } from '../calendar/calendar.ts';
import {
  completionReport,
  markActivityViewed,
  toggleManualCompletion,
} from '../completion/completion.ts';
import {
  enrolUsers,
  listParticipants,
  selfEnrol,
  setEnrolmentStatus,
  unenrolUser,
  updateSelfEnrolment,
} from '../enrol/enrol.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { createGroup, listGroupNames, listGroups, setGroupMembers } from '../groups/groups.ts';
import { assignSystemRole } from '../users/users.ts';
import {
  createActivity,
  deleteActivity,
  duplicateActivity,
  getActivityAccess,
  getCourseOutline,
  moveActivity,
  restoreActivity,
  updateActivity,
} from './activities.ts';
import { createCategory, deleteCategory, getCategoryTree, updateCategory } from './categories.ts';
import {
  addSection,
  createCourse,
  deleteSection,
  getCourseAccess,
  listMyCourses,
  moveSection,
  searchCatalog,
  updateCourse,
} from './courses.ts';

describe('courses domain', () => {
  const t = useTestDb({ profile: 'demo' });
  const ids = {} as Record<string, string>;

  beforeAll(async () => {
    const users = await t.db.user.findMany({ select: { id: true, username: true } });
    for (const u of users) if (u.username) ids[u.username] = u.id;
    const roles = await t.db.role.findMany();
    for (const r of roles) ids[`role:${r.shortName}`] = r.id;
  });

  it('manager builds a category tree; cannot move a category into its child', async () => {
    const ctx = await ctxFor(t.db, 'manager@hubium.local');
    const { id: school } = await createCategory.run(ctx, { name: 'Школа' });
    const { id: math } = await createCategory.run(ctx, { name: 'Математика', parentId: school });
    ids.school = school;
    ids.math = math;
    const tree = await getCategoryTree(t.db);
    expect(tree.find((c) => c.id === school)?.children.map((c) => c.name)).toEqual(['Математика']);
    await expect(
      updateCategory.run(ctx, { id: school, name: 'Школа', parentId: math }),
    ).rejects.toBeInstanceOf(ValidationError);
    const mathCtx = await t.db.context.findUniqueOrThrow({ where: { id: math } });
    expect(mathCtx.ancestorIds).toEqual([SYSTEM_CONTEXT_ID, school]);
  });

  it('students cannot create categories or courses', async () => {
    const ctx = await ctxFor(t.db, 'student1@hubium.local');
    await expect(createCategory.run(ctx, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createCourse.run(ctx, { categoryId: ids.math!, fullName: 'X', shortName: 'X' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('course creator creates a course and becomes its teacher', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await assignSystemRole.run(admin, {
      userId: ids.teacher!,
      roleId: ids['role:coursecreator']!,
      assigned: true,
    });
    const ctx = await ctxFor(t.db, 'teacher@hubium.local');
    const { id } = await createCourse.run(ctx, {
      categoryId: ids.math!,
      fullName: 'Алгебра 7',
      shortName: 'ALG7',
      summary: '<p>Курс <script>x</script>алгебры</p>',
      sections: 3,
    });
    ids.course = id;
    const course = await t.db.course.findUniqueOrThrow({ where: { id } });
    expect(course.summary).toBe('<p>Курс алгебры</p>');
    expect(await t.db.courseSection.count({ where: { courseId: id } })).toBe(4);
    const tctx = await ctxFor(t.db, 'teacher@hubium.local');
    const access = await getCourseAccess(tctx, id);
    expect(access.canEdit && access.canManageActivities && access.isEnrolled).toBe(true);
    await expect(
      createCourse.run(tctx, { categoryId: ids.math!, fullName: 'Dup', shortName: 'alg7' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('sections: add, reorder, general section is fixed, delete only empty', async () => {
    const ctx = await ctxFor(t.db, 'teacher@hubium.local');
    const before = await t.db.courseSection.findMany({
      where: { courseId: ids.course },
      orderBy: { rank: 'asc' },
    });
    const { id: added } = await addSection.run(ctx, {
      courseId: ids.course!,
      afterSectionId: before[1]!.id,
      title: 'Новая',
    });
    const after = await t.db.courseSection.findMany({
      where: { courseId: ids.course },
      orderBy: { rank: 'asc' },
    });
    expect(after[2]!.id).toBe(added);
    await moveSection.run(ctx, { id: added, direction: 'up' });
    const moved = await t.db.courseSection.findMany({
      where: { courseId: ids.course },
      orderBy: { rank: 'asc' },
    });
    expect(moved[1]!.id).toBe(added);
    await expect(
      moveSection.run(ctx, { id: moved[0]!.id, direction: 'down' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteSection.run(ctx, { id: moved[0]!.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await deleteSection.run(ctx, { id: added });
  });

  it('activities: create with module validation, move, duplicate, recycle bin', async () => {
    const ctx = await ctxFor(t.db, 'teacher@hubium.local');
    const sections = await t.db.courseSection.findMany({
      where: { courseId: ids.course },
      orderBy: { rank: 'asc' },
    });
    ids.s0 = sections[0]!.id;
    ids.s1 = sections[1]!.id;
    await expect(
      createActivity.run(ctx, {
        courseId: ids.course!,
        sectionId: ids.s1!,
        moduleKey: 'url',
        name: 'Bad',
        settings: { url: 'javascript:1' },
      }),
    ).rejects.toMatchObject({ fieldErrors: { 'settings.url': expect.any(Array) } });
    const p = await createActivity.run(ctx, {
      courseId: ids.course!,
      sectionId: ids.s1!,
      moduleKey: 'page',
      name: 'Введение',
      settings: { content: '<p>Hello</p>' },
      completionMode: 'AUTO',
      completionRules: { view: true },
    });
    const m = await createActivity.run(ctx, {
      courseId: ids.course!,
      sectionId: ids.s1!,
      moduleKey: 'page',
      name: 'Упражнения',
      settings: { content: '<p>Tasks</p>' },
      completionMode: 'MANUAL',
    });
    const hidden = await createActivity.run(ctx, {
      courseId: ids.course!,
      sectionId: ids.s1!,
      moduleKey: 'url',
      name: 'Скрытая ссылка',
      visibility: 'HIDDEN',
      settings: { url: 'https://example.com' },
    });
    ids.page = p.id;
    ids.manual = m.id;
    ids.hidden = hidden.id;
    await moveActivity.run(ctx, { id: m.id, sectionId: ids.s1!, beforeId: p.id });
    const order = await t.db.activity.findMany({
      where: { sectionId: ids.s1 },
      orderBy: { rank: 'asc' },
    });
    expect(order.map((a) => a.name)).toEqual(['Упражнения', 'Введение', 'Скрытая ссылка']);
    const dup = await duplicateActivity.run(ctx, { id: p.id });
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: dup.id } })).visibility).toBe(
      'HIDDEN',
    );
    await deleteActivity.run(ctx, { id: dup.id });
    expect(
      (await t.db.activity.findUniqueOrThrow({ where: { id: dup.id } })).deletedAt,
    ).not.toBeNull();
    await restoreActivity.run(ctx, { id: dup.id });
    await deleteActivity.run(ctx, { id: dup.id });
    await expect(
      createActivity.run(ctx, {
        courseId: ids.course!,
        sectionId: ids.s1!,
        moduleKey: 'page',
        name: 'x',
        completionMode: 'AUTO',
        completionRules: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('manual enrolment respects role-assign rules', async () => {
    const ctx = await ctxFor(t.db, 'teacher@hubium.local');
    await enrolUsers.run(ctx, {
      courseId: ids.course!,
      userIds: [ids.student1!, ids.student2!],
      roleId: ids['role:student']!,
    });
    await expect(
      enrolUsers.run(ctx, {
        courseId: ids.course!,
        userIds: [ids.student3!],
        roleId: ids['role:coursecreator']!,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      enrolUsers.run(ctx, {
        courseId: ids.course!,
        userIds: [ids.student3!],
        roleId: ids['role:manager']!,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      enrolUsers.run(ctx, {
        courseId: ids.course!,
        userIds: [ids.student3!],
        roleId: ids['role:editingteacher']!,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const res = await listParticipants(ctx, { courseId: ids.course! });
    expect(res.total).toBe(3);
  });

  it('students see visible activities only; hidden ones stay hidden', async () => {
    const ctx = await ctxFor(t.db, 'student1@hubium.local');
    const access = await getCourseAccess(ctx, ids.course!);
    expect(access.canView && access.isEnrolled && !access.canEdit).toBe(true);
    const outline = await getCourseOutline(ctx, ids.course!);
    const names = outline.flatMap((s) => s.activities.map((a) => a.activity.name));
    expect(names).toEqual(['Упражнения', 'Введение']);
    const hidden = await getActivityAccess(ctx, ids.hidden!);
    expect(hidden).toMatchObject({ canOpen: false, listed: false, missing: [] });
    const outsider = await ctxFor(t.db, 'student3@hubium.local');
    expect((await getCourseAccess(outsider, ids.course!)).canView).toBe(false);
  });

  it('completion: view rule, manual toggle and course progress', async () => {
    const ctx = await ctxFor(t.db, 'student1@hubium.local');
    await t.db.$transaction((tx) => markActivityViewed(ctx, tx, ids.page!, ids.student1!));
    const row = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: ids.page!, userId: ids.student1! } },
    });
    expect(row.state).toBe('COMPLETE');
    const r = await toggleManualCompletion.run(ctx, { activityId: ids.manual!, done: true });
    expect(r.percent).toBe(100);
    const mine = await listMyCourses(t.db, ids.student1!);
    expect(mine.find((c) => c.id === ids.course)?.progress).toBe(100);
    await expect(
      toggleManualCompletion.run(ctx, { activityId: ids.page!, done: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const report = await completionReport(teacher, ids.course!);
    expect(report.learners.find((l) => l.id === ids.student1)?.progress).toBe(100);
    expect(report.learners.find((l) => l.id === ids.student2)?.progress).toBe(0);
  });

  it('availability: completion condition unlocks an activity', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const { id } = await createActivity.run(teacher, {
      courseId: ids.course!,
      sectionId: ids.s1!,
      moduleKey: 'page',
      name: 'Итог',
      settings: { content: '<p>Final</p>' },
      availability: {
        op: '&',
        c: [{ type: 'completion', activityId: ids.manual!, state: 'complete' }],
      },
    });
    const s1 = await getActivityAccess(await ctxFor(t.db, 'student1@hubium.local'), id);
    const s2 = await getActivityAccess(await ctxFor(t.db, 'student2@hubium.local'), id);
    expect(s1.canOpen).toBe(true);
    expect(s2).toMatchObject({ canOpen: false, listed: true });
    expect(s2.missing[0]).toMatchObject({ type: 'completion' });
    await updateActivity.run(teacher, {
      id,
      name: 'Итог',
      settings: { content: '<p>Final</p>' },
      availability: {
        op: '&',
        hidden: true,
        c: [{ type: 'completion', activityId: ids.manual!, state: 'complete' }],
      },
    });
    const outline = await getCourseOutline(
      await ctxFor(t.db, 'student2@hubium.local'),
      ids.course!,
    );
    expect(outline.flatMap((s) => s.activities).some((a) => a.activity.id === id)).toBe(false);
    expect(await getActivityAccess(await ctxFor(t.db, 'student2@hubium.local'), id)).toMatchObject({
      canOpen: false,
      listed: false,
      missing: [],
    });
  });

  it('stealth activities opened by link still obey restrictions and hidden sections', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const { id } = await createActivity.run(teacher, {
      courseId: ids.course!,
      sectionId: ids.s1!,
      moduleKey: 'page',
      name: 'Секрет',
      visibility: 'STEALTH',
      settings: { content: '<p>Secret</p>' },
      availability: {
        op: '&',
        c: [{ type: 'completion', activityId: ids.manual!, state: 'complete' }],
      },
    });
    const access = async (email: string) => getActivityAccess(await ctxFor(t.db, email), id);
    expect(await access('student1@hubium.local')).toMatchObject({ canOpen: true });
    // whoever holds the link is told what the activity still waits for
    expect(await access('student2@hubium.local')).toMatchObject({ canOpen: false, listed: true });
    await t.db.courseSection.update({ where: { id: ids.s1! }, data: { visible: false } });
    try {
      expect(await access('student1@hubium.local')).toMatchObject({
        canOpen: false,
        listed: false,
      });
      expect(await access('teacher@hubium.local')).toMatchObject({ canOpen: true });
    } finally {
      await t.db.courseSection.update({ where: { id: ids.s1! }, data: { visible: true } });
    }
  });

  it('self enrolment with course key and group keys', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const { id: groupId } = await createGroup.run(teacher, {
      courseId: ids.course!,
      name: '7А',
      enrolmentKey: 'seven-a',
    });
    await updateSelfEnrolment.run(teacher, {
      courseId: ids.course!,
      enabled: true,
      key: 'alg-key',
      useGroupKeys: true,
    });
    const s3 = await ctxFor(t.db, 'student3@hubium.local');
    await expect(selfEnrol.run(s3, { courseId: ids.course!, key: 'nope' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await selfEnrol.run(s3, { courseId: ids.course!, key: 'seven-a' });
    expect(
      await t.db.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: ids.student3! } },
      }),
    ).not.toBeNull();
    expect(
      (await getCourseAccess(await ctxFor(t.db, 'student3@hubium.local'), ids.course!)).isEnrolled,
    ).toBe(true);
    ids.group = groupId;
  });

  it('separate groups restrict the participants list', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    await updateCourse.run(teacher, {
      id: ids.course!,
      categoryId: ids.math!,
      fullName: 'Алгебра 7',
      shortName: 'ALG7',
      groupMode: 'SEPARATE',
    });
    await setGroupMembers.run(teacher, { groupId: ids.group!, add: [ids.student1!] });
    const s1 = await ctxFor(t.db, 'student1@hubium.local');
    const list = await listParticipants(s1, { courseId: ids.course! });
    expect(list.users.map((u) => u.id).sort()).toEqual([ids.student1!, ids.student3!].sort());
    const all = await listParticipants(teacher, { courseId: ids.course! });
    expect(all.total).toBe(4);
    // another group's members stay hidden, even when asked for by its id
    const other = await t.db.group.create({ data: { courseId: ids.course!, name: 'Чужая' } });
    await t.db.groupMember.create({ data: { groupId: other.id, userId: ids.student2! } });
    expect((await listParticipants(s1, { courseId: ids.course!, groupId: other.id })).total).toBe(
      0,
    );
    expect((await listGroupNames(s1, ids.course!)).map((g) => g.id)).toEqual([ids.group!]);
    expect((await listGroups(s1, ids.course!)).map((g) => g.id)).toEqual([ids.group!]);
    expect(await listGroupNames(teacher, ids.course!)).toHaveLength(2);
    expect(
      (await listParticipants(teacher, { courseId: ids.course!, groupId: other.id })).users.map(
        (u) => u.id,
      ),
    ).toEqual([ids.student2!]);
    await t.db.group.delete({ where: { id: other.id } });
    await expect(
      setGroupMembers.run(teacher, { groupId: ids.group!, add: [ids.manager!] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('suspended enrolment blocks access; unenrol removes roles and groups', async () => {
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    await setEnrolmentStatus.run(teacher, {
      courseId: ids.course!,
      userId: ids.student2!,
      status: 'SUSPENDED',
    });
    expect(
      (await getCourseAccess(await ctxFor(t.db, 'student2@hubium.local'), ids.course!)).canView,
    ).toBe(false);
    await unenrolUser.run(teacher, { courseId: ids.course!, userId: ids.student3! });
    expect(
      await t.db.roleAssignment.count({ where: { userId: ids.student3!, contextId: ids.course! } }),
    ).toBe(0);
    expect(await t.db.groupMember.count({ where: { userId: ids.student3! } })).toBe(0);
  });

  it('catalog search and calendar events', async () => {
    const anon = await ctxFor(t.db, 'student3@hubium.local');
    const r = await searchCatalog(anon, { q: 'алгебр' });
    expect(r.items.map((c) => c.shortName)).toEqual(['ALG7']);
    const r2 = await searchCatalog(anon, { categoryId: ids.school! });
    expect(r2.total).toBe(1);
    const teacher = await ctxFor(t.db, 'teacher@hubium.local');
    const at = new Date(Date.now() + 2 * 86_400_000);
    await createEvent.run(teacher, {
      scope: 'COURSE',
      courseId: ids.course!,
      title: 'Контрольная',
      startsAt: at,
    });
    const s1 = await ctxFor(t.db, 'student1@hubium.local');
    await createEvent.run(s1, { scope: 'USER', title: 'Личное', startsAt: at });
    await expect(
      createEvent.run(s1, { scope: 'COURSE', courseId: ids.course!, title: 'x', startsAt: at }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const events = await listUserEvents(t.db, ids.student1!, {
      from: new Date(),
      to: new Date(Date.now() + 7 * 86_400_000),
    });
    expect(events.map((e) => e.title).sort()).toEqual(['Контрольная', 'Личное']);
    const other = await listUserEvents(t.db, ids.student3!, {
      from: new Date(),
      to: new Date(Date.now() + 7 * 86_400_000),
    });
    expect(other).toEqual([]);
  });

  it('non-empty categories cannot be deleted', async () => {
    const ctx = await ctxFor(t.db, 'manager@hubium.local');
    await expect(deleteCategory.run(ctx, { id: ids.math! })).rejects.toThrow(/not empty/);
  });
});
