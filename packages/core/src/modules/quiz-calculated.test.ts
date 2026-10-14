import { formatAnswer } from '@hubium/questions';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { listQuestionCategories, saveQuestion } from '../questions/bank.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

// Calculated questions: datasets checked when saved, shared datasets of a category,
// synchronised variants, values kept by the attempt through review and regrading.

const set = (name: string, items: number[]) => ({
  name,
  min: 1,
  max: 10,
  decimals: 0,
  distribution: 'uniform' as const,
  items,
});

describe('quiz: calculated questions', () => {
  const t = useTestDb();

  it('checks datasets, shares them, synchronises variants and keeps values', async () => {
    const f = await courseFixture(t.db, 'QCALC');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const [cat] = await listQuestionCategories(teacher, f.courseId);
    const save = (input: Record<string, unknown>) =>
      saveQuestion.run(teacher, {
        categoryId: cat!.id,
        type: 'CALCULATED',
        defaultMark: 1,
        generalFeedback: '<p>{a} + {b} = {={a}+{b}}</p>',
        ...input,
      } as never);
    const answers = [{ formula: '{a} + {b}', fraction: 1, tolerance: 0.01 }];

    // every variable needs items, and every item must give a number
    await expect(
      save({
        name: 'x',
        text: '<p>{a} + {b}</p>',
        data: { answers, datasets: [set('a', [1]), set('b', [])] },
      }),
    ).rejects.toMatchObject({ fieldErrors: { data: [expect.stringMatching(/dataset items/)] } });
    await expect(
      save({
        name: 'x',
        text: '<p>?</p>',
        data: {
          answers: [{ formula: '{a} / ({b} - 2)', fraction: 1 }],
          datasets: [set('a', [1, 2]), set('b', [3, 2])],
        },
      }),
    ).rejects.toMatchObject({
      fieldErrors: { data: [expect.stringMatching(/^Answer 1 is not a number for item 2/)] },
    });
    await expect(
      save({
        name: 'x',
        text: '<p>{a}</p>',
        data: { answers, datasets: [set('b', [1])], shared: ['a'] },
      }),
    ).rejects.toMatchObject({
      fieldErrors: { data: [expect.stringMatching(/is shared in the category/)] },
    });

    // two questions sharing {a} and {b}, drawn together
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const one = await save({
      name: 'Сумма',
      text: '<p>{a} + {b} = ?</p>',
      data: { answers, shared: ['a', 'b'], synchronize: true },
      sharedDatasets: [
        set('a', items),
        set(
          'b',
          items.map((x) => x * 10),
        ),
      ],
    });
    const two = await save({
      name: 'Разность',
      text: '<p>{b} − {a} = ?</p>',
      data: {
        answers: [{ formula: '{b} - {a}', fraction: 1, format: 'significant', length: 3 }],
        shared: ['a', 'b'],
        synchronize: true,
      },
    });
    expect(await t.db.questionDataset.count({ where: { categoryId: cat!.id } })).toBe(2);

    const quizId = (await f.addActivity('quiz', 'Числа', { attempts: 0, perPage: 0 })).id;
    await runModuleAction(teacher, quizId, 'addQuestions', { questionIds: [one.id, two.id] });
    const s1 = await ctxFor(t.db, f.users.student1!);
    const drawn = new Set<string>();
    let last = '';
    for (let k = 0; k < 6; k++) {
      const { attemptId } = (await runModuleAction(s1, quizId, 'start', {})) as {
        attemptId: string;
      };
      last = attemptId;
      const qas = await t.db.questionAttempt.findMany({
        where: { attemptId },
        orderBy: { slot: 'asc' },
      });
      const vars = qas.map((qa) => (qa.snapshot as { vars: Record<string, string> }).vars);
      // synchronised: both questions of the attempt got the same item
      expect(vars[0]).toEqual(vars[1]);
      drawn.add(JSON.stringify(vars[0]));
      if (k < 5) await runModuleAction(s1, quizId, 'finish', { attemptId });
    }
    expect(drawn.size).toBeGreaterThan(1);

    const attempt = (await runModuleQuery(s1, quizId, 'attempt', { attemptId: last })) as {
      questions: { text: string }[];
    };
    const qa = await t.db.questionAttempt.findFirstOrThrow({ where: { attemptId: last, slot: 1 } });
    const { a, b } = (qa.snapshot as { vars: Record<string, string> }).vars as {
      a: string;
      b: string;
    };
    // the learner sees the values, not the variables
    expect(attempt.questions[0]!.text).toBe(`<p>${a} + ${b} = ?</p>`);
    await runModuleAction(s1, quizId, 'finish', {
      attemptId: last,
      answers: { 1: { text: String(Number(a) + Number(b)) }, 2: { text: '0' } },
    });
    const review = (await runModuleQuery(s1, quizId, 'review', { attemptId: last })) as {
      questions: { verdict: string; correctAnswerText: string | null; generalFeedback: string }[];
    };
    expect(review.questions[0]).toMatchObject({
      verdict: 'correct',
      correctAnswerText: (Number(a) + Number(b)).toFixed(2),
      generalFeedback: `<p>${a} + ${b} = ${Number(a) + Number(b)}</p>`,
    });
    // three significant figures, as Moodle writes them: 72 → 72.0
    expect(review.questions[1]!.correctAnswerText).toBe(
      formatAnswer(Number(b) - Number(a), { format: 'significant', length: 3 }),
    );
    expect(review.questions[1]!.correctAnswerText).toMatch(/^\d+\.?\d*$/);

    // a regrade with a new formula keeps the values the attempt drew
    await saveQuestion.run(teacher, {
      id: one.id,
      categoryId: cat!.id,
      type: 'CALCULATED',
      name: 'Сумма',
      text: '<p>{a} + {b} = ?</p>',
      data: {
        answers: [{ formula: '{a} + {b} + 1', fraction: 1, tolerance: 0 }],
        shared: ['a', 'b'],
        synchronize: true,
      },
    } as never);
    await runModuleAction(teacher, quizId, 'regrade', { dryRun: false });
    const after = await t.db.questionAttempt.findFirstOrThrow({
      where: { attemptId: last, slot: 1 },
    });
    expect((after.snapshot as { vars: unknown }).vars).toEqual({ a, b });
    expect(Number(after.mark)).toBe(0);
  });
});
