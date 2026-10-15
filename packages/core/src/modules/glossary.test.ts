import type { glossaryEntries } from '@hubium/mod-glossary/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';
import { courseAutoLinks } from './autolinks.ts';

type Page = Awaited<ReturnType<typeof glossaryEntries>>;

describe('mod-glossary', () => {
  const t = useTestDb();

  async function setup(
    code: string,
    settings: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const f = await courseFixture(t.db, code);
    const { id } = await f.addActivity('glossary', 'Термины', settings, extra);
    const [teacher, s1, s2] = await Promise.all(
      [f.users.teacher!, f.users.student1!, f.users.student2!].map((u) => ctxFor(t.db, u)),
    );
    return { f, id, teacher: teacher!, s1: s1!, s2: s2! };
  }
  const add = (ctx: Awaited<ReturnType<typeof ctxFor>>, id: string, concept: string, more = {}) =>
    runModuleAction(ctx, id, 'addEntry', {
      concept,
      definition: `<p>Про ${concept}</p>`,
      ...more,
    }) as Promise<{ id: string; approved: boolean }>;
  const list = (ctx: Awaited<ReturnType<typeof ctxFor>>, id: string, q = {}) =>
    runModuleQuery(ctx, id, 'entries', q) as Promise<Page>;

  it('approval, duplicates, editing and browsing', async () => {
    const { f, id, teacher, s1, s2 } = await setup(
      'GLS1',
      { approvalRequired: true },
      { completionMode: 'AUTO', completionRules: { module: { entries: 1 } } },
    );
    const completion = async () =>
      (
        await t.db.activityCompletion.findUnique({
          where: { activityId_userId: { activityId: id, userId: f.users.student1! } },
        })
      )?.state ?? 'INCOMPLETE';
    const own = await add(s1, id, 'Энтропия', {
      aliases: 'энтропии, энтропию',
      categories: 'Физика',
    });
    expect(own.approved).toBe(false);
    // a teacher's entry needs no approval
    expect((await add(teacher, id, 'Atom', { categories: 'Физика, Химия' })).approved).toBe(true);
    await add(teacher, id, '42');
    // the same concept again, in another case
    await expect(add(s2, id, 'энтропия')).rejects.toMatchObject({ code: 'CONFLICT' });

    // others do not see an entry waiting for approval; its author and teachers do
    expect((await list(s2, id)).items.map((e) => e.concept)).toEqual(['42', 'Atom']);
    expect((await list(s1, id)).items.map((e) => e.concept)).toEqual(['42', 'Atom', 'Энтропия']);
    const all = await list(teacher, id);
    expect(all).toMatchObject({ total: 3, pendingCount: 1, letters: ['A', 'Э', '#'] });
    expect(all.categories).toEqual(['Физика', 'Химия']);
    expect((await list(s2, id, { category: 'Химия' })).items.map((e) => e.concept)).toEqual([
      'Atom',
    ]);
    expect((await list(teacher, id, { letter: '#' })).items.map((e) => e.concept)).toEqual(['42']);
    expect((await list(teacher, id, { search: 'энтропию' })).total).toBe(1);

    // learners change their own entries only
    await expect(
      runModuleAction(s2, id, 'updateEntry', { id: own.id, concept: 'Чужое' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runModuleAction(s1, id, 'updateEntry', {
      id: own.id,
      concept: 'Энтропия',
      definition: '<p>Мера беспорядка<script>alert(1)</script></p>',
    });
    const mine = await runModuleQuery(s1, id, 'entry', { id: own.id });
    expect(mine).toMatchObject({ definition: '<p>Мера беспорядка</p>', aliases: [] });

    // approval makes it visible to everybody, and counts for completion
    expect(await completion()).toBe('INCOMPLETE');
    await expect(
      runModuleAction(s1, id, 'approveEntry', { id: own.id, approved: true }),
    ).rejects.toThrow();
    await runModuleAction(teacher, id, 'approveEntry', { id: own.id, approved: true });
    expect((await list(s2, id)).total).toBe(3);
    expect(await completion()).toBe('COMPLETE');
    await runModuleAction(teacher, id, 'approveEntry', { id: own.id, approved: false });
    expect(await completion()).toBe('INCOMPLETE');
  });

  it('teachers rate approved entries; the ratings make the author’s grade', async () => {
    const { f, id, teacher, s1, s2 } = await setup('GLS2', {
      ratingAggregate: 'average',
      ratingMax: 10,
    });
    const gradeOf = async (userId: string) => {
      const item = await t.db.gradeItem.findFirst({ where: { activityId: id } });
      if (!item) return 'no item';
      const g = await t.db.grade.findUnique({
        where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
      });
      return g?.finalGrade == null ? null : Number(g.finalGrade);
    };
    const a = await add(s1, id, 'Вектор');
    const b = await add(s1, id, 'Матрица');
    await runModuleAction(teacher, id, 'rate', { entryId: a.id, value: 6 });
    await runModuleAction(teacher, id, 'rate', { entryId: b.id, value: 9 });
    expect(await gradeOf(f.users.student1!)).toBe(7.5);
    // the author sees the aggregate but cannot rate, nor see who rated; students do not rate
    const seen = (await list(s1, id)).items.find((e) => e.id === a.id)!;
    expect(seen.rating).toMatchObject({ aggregate: 6, canRate: false, raters: [] });
    await expect(
      runModuleAction(s2, id, 'rate', { entryId: a.id, value: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      runModuleAction(teacher, id, 'rate', { entryId: a.id, value: 11 }),
    ).rejects.toThrow(/0 to 10/);
    // a deleted entry's ratings no longer count
    await runModuleAction(s1, id, 'deleteEntry', { id: b.id });
    expect(await gradeOf(f.users.student1!)).toBe(6);
    // new settings regrade; ratings off remove the item
    await updateActivity.run(teacher, {
      id,
      name: 'Термины',
      settings: { ratingAggregate: 'count', ratingMax: 10 },
    });
    expect(await gradeOf(f.users.student1!)).toBe(1);
    await updateActivity.run(teacher, {
      id,
      name: 'Термины',
      settings: { ratingAggregate: 'none' },
    });
    expect(await gradeOf(f.users.student1!)).toBe('no item');
    await expect(
      runModuleAction(teacher, id, 'rate', { entryId: a.id, value: 1 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('links the concepts of approved entries in the course for those who may open it', async () => {
    const { f, id, teacher, s1, s2 } = await setup('GLS3', {
      autoLink: true,
      approvalRequired: true,
    });
    const e = await add(teacher, id, 'Энтропия', { aliases: 'энтропии', autoLink: true });
    await add(teacher, id, 'Атом', { autoLink: false });
    await add(s1, id, 'Ион', { autoLink: true });
    const links = await courseAutoLinks(s2, f.courseId);
    expect(links).toEqual([
      {
        words: ['Энтропия', 'энтропии'],
        url: `/course/${f.courseId}/a/${id}?entry=${e.id}`,
        title: 'Термины: Энтропия',
        caseSensitive: false,
        fullMatch: true,
      },
    ]);
    // a hidden glossary links nothing for students; linking off links nothing at all
    await updateActivity.run(teacher, {
      id,
      name: 'Термины',
      visibility: 'HIDDEN',
      settings: { autoLink: true },
    });
    expect(await courseAutoLinks(s2, f.courseId)).toEqual([]);
    expect(await courseAutoLinks(teacher, f.courseId)).toHaveLength(1);
    await updateActivity.run(teacher, {
      id,
      name: 'Термины',
      visibility: 'SHOWN',
      settings: { autoLink: false },
    });
    expect(await courseAutoLinks(teacher, f.courseId)).toEqual([]);
  });
});
