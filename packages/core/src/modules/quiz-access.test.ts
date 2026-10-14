import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import type { RequestContext } from '../context.ts';
import { updateActivity } from '../courses/activities.ts';
import { importGift } from '../questions/bank.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

const GIFT = [1, 2, 3, 4, 5].map((n) => `::В${n}:: ${n} + ${n} = ? {=${n * 2}}`).join('\n\n');

describe('quiz access rules and navigation', () => {
  const t = useTestDb();

  async function setup(code: string, settings: Record<string, unknown>) {
    const f = await courseFixture(t.db, code);
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await importGift.run(teacher, { courseId: f.courseId, gift: GIFT });
    const quizId = (await f.addActivity('quiz', 'Тест', { attempts: 0, ...settings })).id;
    const qs = await t.db.question.findMany({
      where: { category: { contextId: f.courseId } },
      orderBy: { name: 'asc' },
    });
    await runModuleAction(teacher, quizId, 'addQuestions', { questionIds: qs.map((q) => q.id) });
    return { f, teacher, quizId };
  }
  const start = async (ctx: RequestContext, quizId: string, input = {}) =>
    ((await runModuleAction(ctx, quizId, 'start', input)) as { attemptId: string }).attemptId;
  const pages = async (quizId: string) =>
    (await t.db.quizSlot.findMany({ where: { activityId: quizId }, orderBy: { slot: 'asc' } })).map(
      (s) => s.page,
    );

  it('asks for the password, an override’s first, and never shows it to learners', async () => {
    const { f, teacher, quizId } = await setup('QAC1', { password: 'Секрет' });
    const s1 = await ctxFor(t.db, f.users.student1!);
    await expect(start(s1, quizId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(start(s1, quizId, { password: 'секрет' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const attemptId = await start(s1, quizId, { password: 'Секрет' });
    // an attempt in progress resumes without asking again
    expect(await start(s1, quizId)).toBe(attemptId);
    const seen = JSON.stringify([
      await runModuleQuery(s1, quizId, 'overview', {}),
      await runModuleQuery(s1, quizId, 'attempt', { attemptId }),
    ]);
    expect(seen).not.toContain('Секрет');
    expect(seen).toContain('"requiresPassword":true');

    // previews need it too
    await expect(start(teacher, quizId, { preview: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await start(teacher, quizId, { preview: true, password: 'Секрет' });

    // '' lifts it for one learner; another gets their own
    await runModuleAction(teacher, quizId, 'setOverride', {
      userId: f.users.student2,
      password: '',
    });
    await runModuleAction(teacher, quizId, 'setOverride', {
      userId: f.users.student3,
      password: 'Своё',
    });
    await start(await ctxFor(t.db, f.users.student2!), quizId);
    const s3 = await ctxFor(t.db, f.users.student3!);
    await expect(start(s3, quizId, { password: 'Секрет' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await start(s3, quizId, { password: 'Своё' });
  });

  it('takes attempts only from the allowed network and after the wait', async () => {
    const { f, quizId } = await setup('QAC2', { subnet: '192.168.1.0/24', delay1Min: 10 });
    const base = await ctxFor(t.db, f.users.student1!);
    const outside = { ...base, ip: '10.0.0.1' };
    const inside = { ...base, ip: '192.168.1.5' };
    await expect(start(outside, quizId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await runModuleQuery(outside, quizId, 'overview', {})).toMatchObject({
      networkAllowed: false,
    });
    const attemptId = await start(inside, quizId);
    // the network is checked on every step of the attempt
    await expect(
      runModuleAction(outside, quizId, 'save', { attemptId, answers: { 1: { text: '2' } } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runModuleAction(inside, quizId, 'finish', { attemptId });

    await expect(start(inside, quizId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const overview = (await runModuleQuery(inside, quizId, 'overview', {})) as {
      nextAttemptAt: string | null;
    };
    expect(new Date(overview.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    const later = { ...inside, now: new Date(Date.now() + 11 * 60_000) };
    await start(later, quizId);
  });

  it('goes page by page with sequential navigation', async () => {
    const { f, quizId } = await setup('QAC3', { navMethod: 'sequential', perPage: 2 });
    expect(await pages(quizId)).toEqual([1, 1, 2, 2, 3]);
    const s1 = await ctxFor(t.db, f.users.student1!);
    const attemptId = await start(s1, quizId);
    const read = async () =>
      (await runModuleQuery(s1, quizId, 'attempt', { attemptId })) as {
        currentPage: number;
        pages: number[];
        questions: { slot: number }[];
        navigation: { slot: number; answered: boolean }[];
      };
    const first = await read();
    expect(first).toMatchObject({ currentPage: 1, pages: [1, 2, 3] });
    // only this page's questions reach the browser; the panel knows all of them
    expect(first.questions.map((q) => q.slot)).toEqual([1, 2]);
    expect(first.navigation.map((n) => n.slot)).toEqual([1, 2, 3, 4, 5]);

    const go = (to: number, answers = {}) =>
      runModuleAction(s1, quizId, 'page', { attemptId, to, answers });
    await expect(
      runModuleAction(s1, quizId, 'save', { attemptId, answers: { 3: { text: '6' } } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(go(3)).rejects.toMatchObject({ code: 'CONFLICT' });
    await go(2, { 1: { text: '2' } });
    const second = await read();
    expect(second.questions.map((q) => q.slot)).toEqual([3, 4]);
    expect(second.navigation.find((n) => n.slot === 1)?.answered).toBe(true);
    await expect(go(1)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      runModuleAction(s1, quizId, 'save', { attemptId, answers: { 1: { text: '9' } } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await go(3, { 3: { text: '6' } });
    await runModuleAction(s1, quizId, 'finish', { attemptId, answers: { 5: { text: '10' } } });
    const qa = await t.db.questionAttempt.findMany({
      where: { attemptId },
      orderBy: { slot: 'asc' },
    });
    expect(qa.map((q) => Number(q.mark))).toEqual([1, 0, 1, 0, 1]);
  });

  it('lets learners go back with free navigation and remembers their page', async () => {
    const { f, quizId } = await setup('QAC4', { perPage: 2 });
    const s1 = await ctxFor(t.db, f.users.student1!);
    const attemptId = await start(s1, quizId);
    await runModuleAction(s1, quizId, 'page', { attemptId, to: 3 });
    await runModuleAction(s1, quizId, 'page', { attemptId, to: 1 });
    const r = (await runModuleQuery(s1, quizId, 'attempt', { attemptId })) as {
      currentPage: number;
      questions: unknown[];
    };
    expect(r.currentPage).toBe(1);
    expect(r.questions).toHaveLength(5);
  });

  it('edits pages: breaks, joins, laying out again and a new perPage', async () => {
    const { teacher, quizId } = await setup('QAC5', { perPage: 2 });
    await runModuleAction(teacher, quizId, 'editSlot', { slot: 1, op: 'pageBreak' });
    expect(await pages(quizId)).toEqual([1, 2, 3, 3, 4]);
    await runModuleAction(teacher, quizId, 'editSlot', { slot: 1, op: 'pageBreak' });
    expect(await pages(quizId)).toEqual([1, 1, 2, 2, 3]);
    await runModuleAction(teacher, quizId, 'editSlot', { slot: 2, op: 'down' });
    expect(await pages(quizId)).toEqual([1, 1, 2, 2, 3]);
    await runModuleAction(teacher, quizId, 'editSlot', { slot: 1, op: 'remove' });
    expect(await pages(quizId)).toEqual([1, 2, 2, 3]);
    await runModuleAction(teacher, quizId, 'repaginate', { perPage: 3 });
    expect(await pages(quizId)).toEqual([1, 1, 1, 2]);
    await updateActivity.run(teacher, { id: quizId, name: 'Тест', settings: { perPage: 1 } });
    expect(await pages(quizId)).toEqual([1, 2, 3, 4]);
  });

  it('refuses addresses it cannot read in the settings', async () => {
    const f = await courseFixture(t.db, 'QAC6');
    await expect(
      f.addActivity('quiz', 'Тест', { subnet: '10.0.0.0/8, кабинет 5' }),
    ).rejects.toThrow();
  });
});
