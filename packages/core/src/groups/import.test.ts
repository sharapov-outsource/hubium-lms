import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ValidationError } from '../errors.ts';
import { autoCreateGroups, groupName, importCohorts, importCourseGroups } from './import.ts';

describe('CSV import of groups and cohorts', () => {
  const t = useTestDb();

  it('previews, then creates groups and groupings and adds enrolled people', async () => {
    const f = await courseFixture(t.db, 'IMPG');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const csv = [
      'group;grouping;user',
      'Группа 1;Поток А;student1',
      'Группа 1;Поток А;STUDENT2',
      'Группа 2;Поток А;student3',
      'Группа 2;;nobody',
      'Группа 3;;admin',
      ';;student1',
      'Группа 4;;',
    ].join('\n');
    const preview = await importCourseGroups.run(teacher, { courseId: f.courseId, csv });
    expect(preview).toMatchObject({
      applied: false,
      created: ['Группа 1', 'Группа 2', 'Группа 4'],
      createdGroupings: ['Поток А'],
      memberships: 3,
      errors: 3,
    });
    expect(preview.lines.filter((l) => l.error).map((l) => [l.line, l.error])).toEqual([
      [5, 'No such user'],
      [6, 'Not enrolled in the course'],
      [7, 'No group name'],
    ]);
    expect(await t.db.group.count({ where: { courseId: f.courseId } })).toBe(0);

    await importCourseGroups.run(teacher, { courseId: f.courseId, csv, apply: true });
    const groups = await t.db.group.findMany({
      where: { courseId: f.courseId },
      orderBy: { name: 'asc' },
      include: { members: true, groupings: { include: { grouping: true } } },
    });
    expect(groups.map((g) => [g.name, g.members.length, g.groupings.length])).toEqual([
      ['Группа 1', 2, 1],
      ['Группа 2', 1, 1],
      ['Группа 4', 0, 0],
    ]);

    // a second import adds to what is there
    await importCourseGroups.run(teacher, {
      courseId: f.courseId,
      csv: 'group,user\nГруппа 4,student1',
      apply: true,
    });
    const g4 = await t.db.group.findFirstOrThrow({
      where: { courseId: f.courseId, name: 'Группа 4' },
      include: { members: true },
    });
    expect(g4.members).toHaveLength(1);
    await expect(
      importCourseGroups.run(teacher, { courseId: f.courseId, csv: 'name\nx' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('creates cohorts by idnumber or name and keeps synced courses in step', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const csv = [
      'name,idnumber,description,user',
      'Физики 2026,phys26,Первый курс,student1',
      'Физики 2026,phys26,,student2',
      'Химики,,,student3',
      'Химики,,,ghost',
    ].join('\n');
    const preview = await importCohorts.run(admin, { csv });
    expect(preview).toMatchObject({
      created: ['Физики 2026', 'Химики'],
      memberships: 3,
      errors: 1,
    });
    const done = await importCohorts.run(admin, { csv, apply: true });
    expect(done.errors).toBe(1);
    const phys = await t.db.cohort.findUniqueOrThrow({
      where: { idNumber: 'phys26' },
      include: { members: true },
    });
    expect(phys).toMatchObject({ name: 'Физики 2026', description: 'Первый курс' });
    expect(phys.members).toHaveLength(2);
    // matched by idnumber the next time, even under another name
    const again = await importCohorts.run(admin, {
      csv: 'name,idnumber,user\nPhysics,phys26,student3',
      apply: true,
    });
    expect(again.created).toEqual([]);
    expect(await t.db.cohortMember.count({ where: { cohortId: phys.id } })).toBe(3);
  });
});

describe('auto-created groups', () => {
  const t = useTestDb();

  it('names groups like Moodle and deals people out evenly', async () => {
    expect([0, 1, 25, 26, 27].map((i) => groupName('Группа @', i))).toEqual([
      'Группа A',
      'Группа B',
      'Группа Z',
      'Группа AA',
      'Группа AB',
    ]);
    expect(groupName('Team #', 9)).toBe('Team 10');

    const f = await courseFixture(t.db, 'AUTOG');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const r = await autoCreateGroups.run(teacher, {
      courseId: f.courseId,
      roleId: f.roles.student!,
      by: 'size',
      number: 2,
      pattern: 'Команда #',
      order: 'name',
      grouping: 'Команды',
    });
    expect(r).toEqual({ groups: ['Команда 1', 'Команда 2'], people: 3 });
    const groups = await t.db.group.findMany({
      where: { courseId: f.courseId },
      orderBy: { name: 'asc' },
      include: { members: true, groupings: true },
    });
    expect(groups.map((g) => [g.name, g.members.length, g.groupings.length])).toEqual([
      ['Команда 1', 2, 1],
      ['Команда 2', 1, 1],
    ]);
    // names that exist already are refused before anything is made
    await expect(
      autoCreateGroups.run(teacher, {
        courseId: f.courseId,
        roleId: f.roles.student!,
        by: 'count',
        number: 3,
        pattern: 'Команда #',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
