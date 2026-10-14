import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import {
  courseValuesFor,
  deleteCourseField,
  foreignCourseValues,
  listCourseFields,
  saveCourseField,
} from './course-fields.ts';
import { searchCatalog, updateCourse } from './courses.ts';

describe('custom course fields', () => {
  const t = useTestDb();

  it('are filled by editors, locked ones by managers, and filter the catalog', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id: levelId } = await saveCourseField.run(admin, {
      shortName: 'Level',
      name: { ru: 'Уровень' },
      type: 'menu',
      choices: ['Начальный', 'Продвинутый'],
      required: true,
    });
    await saveCourseField.run(admin, {
      shortName: 'cert',
      name: { ru: 'Сертификат' },
      type: 'checkbox',
    });
    await saveCourseField.run(admin, {
      shortName: 'code',
      name: { ru: 'Код программы' },
      type: 'text',
      locked: true,
      visible: false,
    });
    expect((await listCourseFields(t.db)).map((f) => f.shortName)).toEqual([
      'level',
      'cert',
      'code',
    ]);

    const f = await courseFixture(t.db, 'CFIELDS');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const base = {
      id: course.id,
      categoryId: course.categoryId,
      fullName: course.fullName,
      shortName: course.shortName,
    };
    await updateCourse.run(teacher, {
      ...base,
      customFields: { level: 'Начальный', cert: 'да' },
    });
    expect(
      (await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } })).customFields,
    ).toEqual({ level: 'Начальный', cert: true });

    // a required field cannot be emptied, a menu takes only its options
    await expect(
      updateCourse.run(teacher, { ...base, customFields: { level: '' } }),
    ).rejects.toMatchObject({ fieldErrors: { cf_level: ['Required'] } });
    await expect(
      updateCourse.run(teacher, { ...base, customFields: { level: 'Эксперт' } }),
    ).rejects.toMatchObject({ fieldErrors: { cf_level: ['Choose one of the options'] } });
    // the locked field is for managers; other values stay as they were
    await expect(
      updateCourse.run(teacher, { ...base, customFields: { code: 'P-1' } }),
    ).rejects.toMatchObject({ fieldErrors: { cf_code: ['This field is locked'] } });
    await updateCourse.run(admin, { ...base, customFields: { code: 'P-1' } });
    expect(
      (await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } })).customFields,
    ).toEqual({ level: 'Начальный', cert: true, code: 'P-1' });

    // learners see the visible fields only
    const saved = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const student = await ctxFor(t.db, f.users.student1!);
    expect(await courseValuesFor(student, saved)).toEqual({ level: 'Начальный', cert: true });
    expect(await courseValuesFor(teacher, saved)).toEqual({
      level: 'Начальный',
      cert: true,
      code: 'P-1',
    });

    const found = await searchCatalog(student, { fields: { level: 'Начальный', cert: 'yes' } });
    expect(found.items.map((c) => c.id)).toContain(f.courseId);
    for (const fields of [{ level: 'Продвинутый' }, { cert: 'no' }] as Record<string, string>[])
      expect((await searchCatalog(student, { fields })).items.map((c) => c.id)).not.toContain(
        f.courseId,
      );
    // a hidden field does not filter
    expect(
      (await searchCatalog(student, { fields: { code: 'other' } })).items.map((c) => c.id),
    ).toContain(f.courseId);

    // renaming a field carries its values; deleting it drops them
    await saveCourseField.run(admin, {
      id: levelId,
      shortName: 'grade_level',
      name: { ru: 'Уровень' },
      type: 'menu',
      choices: ['Начальный', 'Продвинутый'],
    });
    expect(
      (await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } })).customFields,
    ).toMatchObject({ grade_level: 'Начальный' });
    await deleteCourseField.run(admin, { id: levelId });
    expect(
      (await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } })).customFields,
    ).toEqual({ cert: true, code: 'P-1' });

    // values from elsewhere fit this site's fields or are left out
    const fields = await listCourseFields(t.db);
    expect(foreignCourseValues(fields, { cert: '1', code: 'X', other: 'y' })).toEqual({
      cert: true,
      code: 'X',
    });
    await expect(
      saveCourseField.run(teacher, { shortName: 'x1', name: { ru: 'X' }, type: 'text' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
