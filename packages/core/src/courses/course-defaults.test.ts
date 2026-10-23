import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { dropEmptyDefaultCategory } from '../questions/bank.ts';
import { createCategory } from './categories.ts';
import { createCourse } from './courses.ts';

// A course comes with its gradebook and the default category of its question bank, so
// its pages only read them.

describe('a new course', () => {
  const t = useTestDb();

  it('has its gradebook and the default category of its question bank', async () => {
    const sys = await ctxFor(t.db, 'system');
    const { id: categoryId } = await createCategory.run(sys, { name: 'Defaults' });
    const { id } = await createCourse.run(sys, {
      categoryId,
      fullName: 'Defaults',
      shortName: 'DEFAULTS',
    });
    const root = await t.db.gradeCategory.findFirstOrThrow({
      where: { courseId: id, parentId: null },
    });
    expect(
      await t.db.gradeItem.findFirst({ where: { courseId: id, kind: 'COURSE' } }),
    ).toMatchObject({ categoryId: root.id });
    const bank = await t.db.questionCategory.findMany({ where: { contextId: id } });
    expect(bank).toMatchObject([{ name: '', parentId: null }]);

    // a restore that brings top categories of its own drops the empty one
    await dropEmptyDefaultCategory(t.db, id);
    expect(await t.db.questionCategory.count({ where: { contextId: id } })).toBe(1);
    await t.db.questionCategory.create({ data: { contextId: id, name: 'Restored' } });
    await dropEmptyDefaultCategory(t.db, id);
    expect(await t.db.questionCategory.findMany({ where: { contextId: id } })).toMatchObject([
      { name: 'Restored' },
    ]);
  });
});
