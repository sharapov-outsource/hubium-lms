import { responseSheet } from '@hubium/mod-feedback/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';

type Analysis =
  | { visible: false }
  | {
      visible: true;
      responses: number;
      items: {
        label: string;
        answered: number;
        choices?: { text: string; count: number }[];
        numbers?: { average: number } | null;
        texts?: string[];
      }[];
    };

describe('mod-feedback', () => {
  const t = useTestDb();

  it('takes answers, keeps them anonymous and sums them up', async () => {
    const f = await courseFixture(t.db, 'FEEDBACK1');
    const { id } = await f.addActivity('feedback', 'Отзыв о курсе', {
      anonymous: true,
      showAnalysis: true,
      notifyTeachers: true,
    });
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const add = async (input: object) =>
      ((await runModuleAction(teacher, id, 'addItem', input)) as { id: string }).id;
    const mark = await add({
      type: 'number',
      label: 'Оценка курса',
      min: 1,
      max: 5,
      required: true,
    });
    const liked = await add({
      type: 'choice',
      label: 'Что понравилось',
      choices: ['Лекции', 'Практика'],
      multiple: true,
    });
    const comment = await add({ type: 'textarea', label: 'Комментарий' });
    // a question needs its text, a choice two options
    await expect(runModuleAction(teacher, id, 'addItem', { type: 'text' })).rejects.toThrow();
    await expect(
      runModuleAction(teacher, id, 'addItem', { type: 'choice', label: 'X', choices: ['А'] }),
    ).rejects.toThrow();
    await runModuleAction(teacher, id, 'moveItem', { id: comment, direction: 'up' });
    expect(
      ((await runModuleQuery(teacher, id, 'items', {})) as { id: string }[]).map((i) => i.id),
    ).toEqual([mark, comment, liked]);

    const s1 = await ctxFor(t.db, f.users.student1!);
    const s2 = await ctxFor(t.db, f.users.student2!);
    expect(((await runModuleQuery(s1, id, 'analysis', {})) as Analysis).visible).toBe(false);
    await expect(
      runModuleAction(s1, id, 'submit', { answers: { [comment]: 'Без оценки' } }),
    ).rejects.toThrow('an answer is required');
    await runModuleAction(s1, id, 'submit', {
      answers: { [mark]: '5', [liked]: ['Лекции', 'Практика'], [comment]: 'Всё понятно' },
    });
    await runModuleAction(s2, id, 'submit', { answers: { [mark]: 3, [liked]: ['Практика'] } });
    // one answer each, also when sent twice at once
    const s3 = await ctxFor(t.db, f.users.student3!);
    const twice = await Promise.allSettled(
      [1, 2].map(() => runModuleAction(s3, id, 'submit', { answers: { [mark]: 4 } })),
    );
    expect(twice.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await t.db.feedbackResponse.count({ where: { activityId: id, userId: f.users.student3! } }),
    ).toBe(1);
    await t.db.feedbackResponse.deleteMany({
      where: { activityId: id, userId: f.users.student3! },
    });
    await expect(
      runModuleAction(s1, id, 'submit', { answers: { [mark]: 1 } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // learners see the numbers, not what others wrote
    const seen = (await runModuleQuery(s1, id, 'analysis', {})) as Analysis & { visible: true };
    expect(seen.responses).toBe(2);
    expect(seen.items.find((i) => i.label === 'Оценка курса')?.numbers?.average).toBe(4);
    expect(seen.items.find((i) => i.label === 'Что понравилось')?.choices).toEqual([
      { text: 'Лекции', count: 1, percent: 50 },
      { text: 'Практика', count: 2, percent: 100 },
    ]);
    expect(seen.items.find((i) => i.label === 'Комментарий')?.texts).toBeUndefined();
    const full = (await runModuleQuery(teacher, id, 'analysis', {})) as Analysis & {
      visible: true;
    };
    expect(full.items.find((i) => i.label === 'Комментарий')?.texts).toEqual(['Всё понятно']);

    // anonymous: the export has no names; teachers were told of each response
    const a = await t.db.activity.findUniqueOrThrow({ where: { id } });
    const rows = await responseSheet(buildModuleCtx(teacher), {
      ...a,
      settings: a.settings,
    } as never);
    expect(rows[0]).toEqual([
      'name',
      'username',
      'submittedAt',
      '1. Оценка курса',
      '2. Комментарий',
      '3. Что понравилось',
    ]);
    expect(rows.slice(1).map((r) => [r[0], r[3], r[5]])).toEqual([
      ['', 5, 'Лекции; Практика'],
      ['', 3, 'Практика'],
    ]);
    // one for each answer taken (the third learner's too, removed since)
    expect(
      await t.db.notification.count({
        where: { userId: f.users.teacher!, type: 'feedback.submitted' },
      }),
    ).toBe(3);
    // the survey is anonymous: the notification does not say who answered
    expect(
      await t.db.notification.count({
        where: { userId: f.users.teacher!, type: 'feedback.submitted', actorId: { not: null } },
      }),
    ).toBe(0);

    const response = await t.db.feedbackResponse.findFirstOrThrow({
      where: { activityId: id, userId: f.users.student2! },
    });
    await runModuleAction(teacher, id, 'deleteResponse', { id: response.id });
    expect(await t.db.feedbackResponse.count({ where: { activityId: id } })).toBe(1);
  });
});
