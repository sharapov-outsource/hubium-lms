import type { workshopOverview } from '@hubium/mod-workshop/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

type Overview = Pick<Awaited<ReturnType<typeof workshopOverview>>, 'phase' | 'toReview' | 'all'> & {
  mine: { id: string; title: string } | null;
  myGradingGrade: number | null;
};

describe('mod-workshop', () => {
  const t = useTestDb();

  it('phases: a form, work handed in, reviews allocated and done, grades into the gradebook', async () => {
    const f = await courseFixture(t.db, 'WSHOP1');
    const { id } = await f.addActivity('workshop', 'Эссе', {
      strategy: 'accumulative',
      gradeMax: 80,
      gradingGradeMax: 20,
    });
    const [teacher, s1, s2, s3] = await Promise.all(
      [f.users.teacher!, f.users.student1!, f.users.student2!, f.users.student3!].map((u) =>
        ctxFor(t.db, u),
      ),
    );
    const act = (ctx: typeof teacher, name: string, input: Record<string, unknown>) =>
      runModuleAction(ctx!, id, name, input);
    // nothing happens before the form is written
    await expect(act(teacher, 'switchPhase', { phase: 'submission' })).rejects.toThrow(/form/);
    await act(teacher, 'saveForm', {
      dimensions: [
        { description: 'Идея', maxGrade: 10, weight: 1 },
        { description: 'Язык', maxGrade: 10, weight: 1 },
      ],
    });
    const form = (await runModuleQuery(s1!, id, 'form', {})) as { dimensions: { id: string }[] };
    const [idea, lang] = form.dimensions.map((d) => d.id) as [string, string];
    // learners hand in only in the submission phase
    await expect(
      act(s1, 'submit', { title: 'Моё эссе', content: '<p>Текст</p>' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await act(teacher, 'switchPhase', { phase: 'submission' });
    for (const [ctx, title] of [
      [s1, 'Эссе 1'],
      [s2, 'Эссе 2'],
      [s3, 'Эссе 3'],
    ] as const)
      await act(ctx, 'submit', { title, content: `<p>${title}</p>` });
    await expect(act(s1, 'submit', { title: 'Без текста', content: '' })).rejects.toThrow(/text/);

    // each work gets two reviewers, never its author
    expect(await act(teacher, 'randomAllocate', { count: 2 })).toEqual({ allocated: 6 });
    const all = (await runModuleQuery(teacher!, id, 'overview', {})) as Overview;
    for (const s of all.all) {
      expect(s.received).toHaveLength(2);
      expect(s.received.some((r) => r.reviewer.id === s.author.id)).toBe(false);
    }

    // assessing waits for the assessment phase
    const mine = (await runModuleQuery(s1!, id, 'overview', {})) as Overview;
    expect(mine.toReview).toHaveLength(2);
    const fill = (a: number, b: number) => ({ [idea]: { grade: a }, [lang]: { grade: b } });
    await expect(
      act(s1, 'assess', { assessmentId: mine.toReview[0]!.assessmentId, filling: fill(8, 8) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await act(teacher, 'switchPhase', { phase: 'assessment' });
    await expect(
      act(s1, 'assess', { assessmentId: mine.toReview[0]!.assessmentId, filling: fill(11, 8) }),
    ).rejects.toThrow(/0 to 10/);
    // reviewers agree on 80 % except one who gives 20 %
    const grades: Record<string, [number, number]> = {};
    for (const ctx of [s1, s2, s3]) {
      const o = (await runModuleQuery(ctx!, id, 'overview', {})) as Overview;
      for (const x of o.toReview) {
        const harsh = ctx === s3 && x.title === 'Эссе 1';
        grades[x.assessmentId] = harsh ? [2, 2] : [8, 8];
        await act(ctx, 'assess', {
          assessmentId: x.assessmentId,
          filling: fill(...grades[x.assessmentId]!),
          feedbackAuthor: 'Хорошо',
        });
      }
    }
    // someone else's assessment cannot be filled in
    const s2Review = ((await runModuleQuery(s2!, id, 'overview', {})) as Overview).toReview[0]!;
    await expect(
      act(s1, 'assess', { assessmentId: s2Review.assessmentId, filling: fill(1, 1) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // grades are calculated in the evaluation phase and go to the gradebook when closed
    await expect(act(teacher, 'calculateGrades', {})).rejects.toMatchObject({ code: 'CONFLICT' });
    await act(teacher, 'switchPhase', { phase: 'evaluation' });
    await act(teacher, 'calculateGrades', {});
    const after = (await runModuleQuery(teacher!, id, 'overview', {})) as Overview;
    const essay1 = after.all.find((s) => s.title === 'Эссе 1')!;
    // (80 + 20) / 2
    expect(essay1.grade).toBe(50);
    expect(after.all.find((s) => s.title === 'Эссе 2')!.grade).toBe(80);
    // the two reviews of essay 1 disagree: neither is nearer the mean, both keep the whole
    expect(essay1.received.map((r) => r.gradingGrade)).toEqual([100, 100]);
    const gradeOf = async (itemNumber: number, userId: string) => {
      const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: id, itemNumber } });
      const g = await t.db.grade.findUnique({
        where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
      });
      return g?.finalGrade == null ? null : Number(g.finalGrade);
    };
    expect(await gradeOf(0, f.users.student1!)).toBeNull();
    // the teacher's grade replaces the calculated one
    await act(teacher, 'gradeSubmission', {
      submissionId: essay1.id,
      gradeOver: 75,
      published: true,
    });
    await act(teacher, 'switchPhase', { phase: 'closed' });
    expect(await gradeOf(0, f.users.student1!)).toBe(60);
    expect(await gradeOf(0, f.users.student2!)).toBe(64);
    expect(await gradeOf(1, f.users.student2!)).toBe(20);
    // authors now see their assessments; a published work is seen by all
    const seen = (await runModuleQuery(s2!, id, 'overview', {})) as Overview & {
      published?: unknown[];
    };
    expect(seen.mine?.title).toBe('Эссе 2');
    // the form cannot change once work has been assessed with it
    await expect(
      act(teacher, 'saveForm', { dimensions: [{ description: 'Новое', maxGrade: 5 }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
