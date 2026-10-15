import type { lessonState } from '@hubium/mod-lesson/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { listModules } from './registry.ts';

type State = Awaited<ReturnType<typeof lessonState>>;
type Ctx = Awaited<ReturnType<typeof ctxFor>>;

describe('mod-lesson', () => {
  const t = useTestDb();

  async function setup(code: string, settings: Record<string, unknown>) {
    const f = await courseFixture(t.db, code);
    const { id } = await f.addActivity('lesson', 'Столицы', settings);
    const [teacher, s1] = await Promise.all(
      [f.users.teacher!, f.users.student1!].map((u) => ctxFor(t.db, u)),
    );
    const add = async (type: string, input: Record<string, unknown>, afterId?: string) =>
      (
        (await runModuleAction(teacher!, id, 'addPage', {
          type,
          afterId: afterId ?? null,
          ...input,
        })) as { id: string }
      ).id;
    return { f, id, teacher: teacher!, s1: s1!, add };
  }
  const state = (ctx: Ctx, id: string) => runModuleQuery(ctx, id, 'state', {}) as Promise<State>;
  const gradeOf = async (activityId: string, userId: string) => {
    const item = await t.db.gradeItem.findFirst({ where: { activityId } });
    if (!item) return 'no item';
    const g = await t.db.grade.findUnique({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
    });
    return g?.finalGrade == null ? null : Number(g.finalGrade);
  };

  const sweep = async () => {
    const lesson = listModules().find((m) => m.key === 'lesson')!;
    const sys = await ctxFor(t.db, 'system');
    await t.db.$transaction((tx) => lesson.cron![0]!.handler(buildModuleCtx(sys, tx)));
  };

  it('a learner goes through pages and questions; points make the grade; essays wait', async () => {
    const { f, id, teacher, s1, add } = await setup('LSN1', {
      customScoring: true,
      maxAttempts: 2,
      gradeMax: 10,
    });
    const intro = await add('content', {
      title: 'Введение',
      contents: '<p>Вспомним столицы.</p>',
      answers: [{ text: 'Дальше', jump: 'next' }],
    });
    const q1 = await add(
      'truefalse',
      {
        title: 'Берлин',
        contents: '<p>Берлин — столица Германии?</p>',
        answers: [
          { text: 'Верно', jump: 'next', score: 1, response: 'Да!' },
          { text: 'Неверно', jump: 'this', score: 0 },
        ],
      },
      intro,
    );
    const q2 = await add(
      'shortanswer',
      { title: 'Франция', answers: [{ text: 'Париж', jump: 'next', score: 2 }] },
      q1,
    );
    const q3 = await add('essay', { title: 'Почему', answers: [{ jump: 'end', score: 5 }] }, q2);
    // pages need their answers
    await expect(
      runModuleAction(teacher, id, 'addPage', { type: 'truefalse', title: 'X', answers: [] }),
    ).rejects.toThrow(/two answers/);

    await runModuleAction(s1, id, 'start', {});
    expect((await state(s1, id)).current?.page.id).toBe(intro);
    // the learner does not see which answers are right
    const introRow = await t.db.lessonPage.findUniqueOrThrow({ where: { id: intro } });
    await runModuleAction(s1, id, 'choose', {
      pageId: intro,
      answerId: (introRow.answers as { id: string }[])[0]!.id,
    });
    const tf = (await state(s1, id)).current!.page as { choices: { id: string; text: string }[] };
    expect(tf.choices.map((c) => c.text)).toEqual(['Верно', 'Неверно']);
    expect(JSON.stringify(tf)).not.toContain('score');
    // wrong, and a second try left: the question again
    expect(
      await runModuleAction(s1, id, 'answer', { pageId: q1, choice: tf.choices[1]!.id }),
    ).toMatchObject({ correct: false, finished: false });
    expect((await state(s1, id)).current?.page.id).toBe(q1);
    // answering another page than the current one is refused
    await expect(
      runModuleAction(s1, id, 'answer', { pageId: q2, text: 'Париж' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await runModuleAction(s1, id, 'answer', { pageId: q1, choice: tf.choices[0]!.id }),
    ).toMatchObject({ correct: true, response: 'Да!' });
    await runModuleAction(s1, id, 'answer', { pageId: q2, text: ' париж ' });
    expect(
      await runModuleAction(s1, id, 'answer', { pageId: q3, text: 'Потому что.' }),
    ).toMatchObject({ essay: true, finished: true });

    // 1 + 2 of 1 + 2 + 5 points, the essay still to grade
    const done = await state(s1, id);
    expect(done.current).toBeNull();
    expect(done.past[0]).toMatchObject({ earned: 3, total: 8, percent: 37.5, pending: 1 });
    expect(await gradeOf(id, f.users.student1!)).toBe(3.75);
    expect(
      await t.db.notification.count({
        where: { userId: f.users.teacher, type: 'lesson.needsGrading' },
      }),
    ).toBe(1);
    // no retakes in this lesson
    await expect(runModuleAction(s1, id, 'start', {})).rejects.toMatchObject({ code: 'CONFLICT' });

    // the teacher grades the essay: 8 of 8
    const essay = await t.db.lessonStep.findFirstOrThrow({ where: { pageId: q3, kind: 'answer' } });
    const view = await t.db.lessonStep.findFirstOrThrow({ where: { pageId: q3, kind: 'view' } });
    await expect(
      runModuleAction(teacher, id, 'gradeEssay', { stepId: view.id, score: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      runModuleAction(teacher, id, 'gradeEssay', { stepId: essay.id, score: 6 }),
    ).rejects.toThrow(/0 to 5/);
    await runModuleAction(teacher, id, 'gradeEssay', {
      stepId: essay.id,
      score: 5,
      comment: 'Хорошо',
    });
    expect(await gradeOf(id, f.users.student1!)).toBe(10);
    // the learner sees the points and the comment
    expect((await state(s1, id)).past[0]).toMatchObject({
      percent: 100,
      pending: 0,
      essays: [{ title: 'Почему', score: 5, max: 5, comment: 'Хорошо' }],
    });

    // the teacher's try is neither graded nor reported; a reset leaves the pages
    await runModuleAction(teacher, id, 'start', { preview: true });
    expect((await state(teacher, id)).current?.preview).toBe(true);
    expect(await t.db.lessonAttempt.count({ where: { activityId: id, preview: false } })).toBe(1);
  });

  it('branches, retries after a wrong answer, a password, a time limit and plain scoring', async () => {
    const { f, id, s1, add } = await setup('LSN2', {
      customScoring: false,
      maxAttempts: 2,
      review: true,
      retake: true,
      password: 'секрет',
      timeLimitMin: 30,
    });
    const menu = await add('content', {
      title: 'Выбор темы',
      answers: [
        { text: 'Европа', jump: 'next' },
        { text: 'Азия', jump: 'end' },
      ],
    });
    const q = await add(
      'numerical',
      { title: 'Сколько', answers: [{ text: '4:6', jump: 'next', response: 'Верно' }] },
      menu,
    );
    await add('endofbranch', { answers: [{ jump: 'lastContent' }] }, q);

    await expect(runModuleAction(s1, id, 'start', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runModuleAction(s1, id, 'start', { password: 'секрет' });
    const page = await t.db.lessonPage.findUniqueOrThrow({ where: { id: menu } });
    const [europe, asia] = (page.answers as { id: string }[]).map((x) => x.id);
    await runModuleAction(s1, id, 'choose', { pageId: menu, answerId: europe });
    // wrong: the lesson offers another try or going on
    expect(await runModuleAction(s1, id, 'answer', { pageId: q, text: '9' })).toMatchObject({
      correct: false,
      retry: true,
    });
    expect((await state(s1, id)).current).toMatchObject({ retry: true, page: { id: q } });
    expect(await runModuleAction(s1, id, 'answer', { pageId: q, text: '5,5' })).toMatchObject({
      correct: true,
    });
    // the end of the branch leads back to the content page
    expect((await state(s1, id)).current?.page.id).toBe(menu);
    await runModuleAction(s1, id, 'choose', { pageId: menu, answerId: asia });
    // every try counts: one right of two
    expect((await state(s1, id)).past[0]).toMatchObject({ earned: 1, total: 2, percent: 50 });
    expect(await gradeOf(id, f.users.student1!)).toBe(50);

    // a retake whose time runs out ends where it was
    await runModuleAction(s1, id, 'start', { password: 'секрет' });
    await t.db.lessonAttempt.updateMany({
      where: { activityId: id, finishedAt: null },
      data: { dueAt: new Date(Date.now() - 1000) },
    });
    // reading the lesson shows it over and writes nothing; the sweep ends it
    const late = await state(s1, id);
    expect(late.current).toBeNull();
    expect(late.past).toHaveLength(1);
    await expect(
      runModuleAction(s1, id, 'choose', { pageId: menu, answerId: europe }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await sweep();
    expect((await state(s1, id)).past).toHaveLength(2);
  });

  it('deleting a page leaves the open attempts going', async () => {
    const { f, id, teacher, s1, add } = await setup('LSN4', {
      customScoring: true,
      maxAttempts: 2,
      gradeMax: 10,
    });
    const intro = await add('content', {
      title: 'Введение',
      answers: [{ text: 'Дальше', jump: 'next' }],
    });
    const tf = (title: string, afterId: string) =>
      add(
        'truefalse',
        {
          title,
          answers: [
            { text: 'Верно', jump: 'next', score: 1 },
            { text: 'Неверно', jump: 'this', score: 0 },
          ],
        },
        afterId,
      );
    const q1 = await tf('Берлин', intro);
    const q2 = await tf('Париж', q1);
    const choices = async (ctx: Ctx) =>
      ((await state(ctx, id)).current!.page as { choices: { id: string }[] }).choices;
    const s2 = await ctxFor(t.db, f.users.student2!);
    for (const s of [s1, s2]) {
      await runModuleAction(s, id, 'start', {});
      const introRow = await t.db.lessonPage.findUniqueOrThrow({ where: { id: intro } });
      await runModuleAction(s, id, 'choose', {
        pageId: intro,
        answerId: (introRow.answers as { id: string }[])[0]!.id,
      });
    }
    // the first learner gets the question wrong, then right
    for (const k of [1, 0])
      await runModuleAction(s1, id, 'answer', { pageId: q1, choice: (await choices(s1))[k]!.id });
    expect((await state(s1, id)).current?.page.id).toBe(q2);
    expect((await state(s2, id)).current?.page.id).toBe(q1);

    await runModuleAction(teacher, id, 'deletePage', { id: q1 });
    // the one on the deleted page goes on to the next; the other's steps add on
    expect((await state(s2, id)).current?.page.id).toBe(q2);
    expect(
      await runModuleAction(s1, id, 'answer', { pageId: q2, choice: (await choices(s1))[0]!.id }),
    ).toMatchObject({ correct: true, finished: true });
    expect(await gradeOf(id, f.users.student1!)).toBe(10);
  });

  it('an open attempt ends when the lesson closes', async () => {
    const closesAt = new Date(Date.now() + 3_600_000).toISOString();
    const { id, teacher, s1, add } = await setup('LSN5', { closesAt });
    const intro = await add('content', {
      title: 'Введение',
      answers: [{ text: 'Дальше', jump: 'next' }],
    });
    await add('content', { title: 'Итог', answers: [{ text: 'Конец', jump: 'end' }] }, intro);
    const { attemptId } = (await runModuleAction(s1, id, 'start', {})) as { attemptId: string };
    const attempt = () => t.db.lessonAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    // without a time limit it ends with the lesson, also for the sweep
    expect((await attempt()).dueAt?.toISOString()).toBe(closesAt);
    // the teacher closes the lesson earlier, while the learner is in it
    const row = await t.db.activity.findUniqueOrThrow({ where: { id } });
    const closed = new Date(Date.now() - 60_000);
    await updateActivity.run(teacher, {
      id,
      name: row.name,
      settings: { ...(row.settings as object), closesAt: closed.toISOString() },
    });
    const introRow = await t.db.lessonPage.findUniqueOrThrow({ where: { id: intro } });
    await expect(
      runModuleAction(s1, id, 'choose', {
        pageId: intro,
        answerId: (introRow.answers as { id: string }[])[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // the lesson shows it over; the sweep ends it, at the close date
    expect((await state(s1, id)).current).toBeNull();
    await sweep();
    expect((await attempt()).finishedAt?.getTime()).toBe(closed.getTime());
  });

  it('a backup carries the pages with their jumps', async () => {
    const { id, add } = await setup('LSN3', {});
    const a = await add('content', { title: 'A', answers: [{ text: 'В конец', jump: 'end' }] });
    const b = await add('content', { title: 'B', answers: [{ text: 'К A', jump: a }] }, a);
    const { getModule } = await import('./registry.ts');
    const { buildModuleCtx, toActivityRef } = await import('./module-ctx.ts');
    const sys = await ctxFor(t.db, 'system');
    const m = getModule('lesson')!;
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    const data = await m.backup!.export!(buildModuleCtx(sys), toActivityRef(act) as never);
    const f2 = await courseFixture(t.db, 'LSN3B');
    const { id: copy } = await f2.addActivity('lesson', 'Копия', {});
    const target = await t.db.activity.findUniqueOrThrow({ where: { id: copy } });
    await m.backup!.import!(
      buildModuleCtx(sys),
      toActivityRef(target) as never,
      data,
      () => undefined,
    );
    const pages = await t.db.lessonPage.findMany({
      where: { activityId: copy },
      orderBy: { sortOrder: 'asc' },
    });
    expect(pages.map((p) => p.title)).toEqual(['A', 'B']);
    expect(pages.map((p) => p.id)).not.toContain(b);
    // the jump to A now leads to the copy of A
    expect((pages[1]!.answers as { jump: string }[])[0]!.jump).toBe(pages[0]!.id);
  });
});
