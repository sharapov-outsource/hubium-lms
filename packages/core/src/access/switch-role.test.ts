import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { useTestDb } from '../../test/helpers.ts';
import { isSwitchableRole } from './roles.ts';

describe('view as role', () => {
  const t = useTestDb();

  it('only allows previewing a course as a weaker role', async () => {
    const f = await courseFixture(t.db, 'SWITCH1');
    expect(await isSwitchableRole(t.db, f.courseId, f.roles.student!)).toBe(true);
    expect(await isSwitchableRole(t.db, f.courseId, f.roles.teacher!)).toBe(true);
    expect(await isSwitchableRole(t.db, f.courseId, f.roles.manager!)).toBe(false);
    expect(await isSwitchableRole(t.db, f.courseId, f.roles.editingteacher!)).toBe(false);
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    // not a course context
    expect(await isSwitchableRole(t.db, course.categoryId, f.roles.student!)).toBe(false);
    expect(await isSwitchableRole(t.db, f.courseId, '00000000-0000-7000-8000-000000000000')).toBe(
      false,
    );
  });
});
