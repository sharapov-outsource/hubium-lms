import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { listQuestionCategories, saveQuestion } from '../questions/bank.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

// Ordering, select missing words and drag and drop into text through a quiz: what the
// learner sees gives no answer away, checks grade them, review explains them.

describe('quiz: ordering and gap questions', () => {
  const t = useTestDb();

  it('take an attempt, from the bank to the review', async () => {
    const f = await courseFixture(t.db, 'QQT1');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const [cat] = await listQuestionCategories(teacher, f.courseId);
    const save = (input: Record<string, unknown>) =>
      saveQuestion.run(teacher, { categoryId: cat!.id, defaultMark: 1, ...input } as never);

    const ordering = await save({
      type: 'ORDERING',
      name: 'А порядок',
      text: '<p>Этапы</p>',
      data: {
        items: [
          { id: 'w', text: 'Написать' },
          { id: 'r', text: 'Выполнить' },
          { id: 't', text: 'Проверить' },
        ],
        grading: 'absolutePosition',
        feedbackCorrect: 'Отлично',
      },
    });
    const choices = [
      { id: 'c1', text: 'list', group: 1 },
      { id: 'c2', text: 'tuple', group: 1 },
      { id: 'c3', text: 'dict', group: 2 },
    ];
    // gaps must match the choices
    await expect(
      save({ type: 'GAPSELECT', name: 'x', text: '<p>[[4]]</p>', data: { choices } }),
    ).rejects.toMatchObject({ fieldErrors: { text: [expect.stringContaining('[[4]]')] } });
    const gaps = await save({
      type: 'GAPSELECT',
      name: 'Б пропуски',
      text: '<p>[[2]] неизменяемый, [[1]] изменяемый, [[3]] — словарь</p>',
      data: { choices },
    });
    const drag = await save({
      type: 'DDWTOS',
      name: 'В перетаскивание',
      text: '<p>[[1]] и [[3]]</p>',
      hints: [{ text: 'Ещё раз', clearWrong: true, showNumCorrect: true }],
      data: { choices: choices.map((c) => ({ ...c, infinite: false })) },
    });
    const quizId = (
      await f.addActivity('quiz', 'Типы', { attempts: 0, perPage: 0, behaviour: 'interactive' })
    ).id;
    await runModuleAction(teacher, quizId, 'addQuestions', {
      questionIds: [ordering.id, gaps.id, drag.id],
    });

    const s1 = await ctxFor(t.db, f.users.student1!);
    const { attemptId } = (await runModuleAction(s1, quizId, 'start', {})) as {
      attemptId: string;
    };
    type Q = {
      slot: number;
      text: string;
      orderItems?: { id: string }[];
      gapPlaces?: { place: number; group: number }[];
      gapChoices?: { id: string }[];
      gapDrag?: boolean;
    };
    const attempt = (await runModuleQuery(s1, quizId, 'attempt', { attemptId })) as {
      questions: Q[];
    };
    const [qo, qg, qd] = attempt.questions;
    expect(qo!.orderItems!.map((i) => i.id)).not.toEqual(['w', 'r', 't']);
    // gaps renumbered by place: the text no longer names the right choices
    expect(qg!.text).toBe('<p>[[1]] неизменяемый, [[2]] изменяемый, [[3]] — словарь</p>');
    expect(qg!.gapPlaces).toEqual([
      { place: 1, group: 1 },
      { place: 2, group: 1 },
      { place: 3, group: 2 },
    ]);
    expect(qd!.gapDrag).toBe(true);
    expect(JSON.stringify(attempt)).not.toContain('Отлично');

    const check = (slot: number, response: object) =>
      runModuleAction(s1, quizId, 'check', { attemptId, slot, response }) as Promise<{
        question: { state: string; feedback: { texts: string[]; numCorrect: object | null } };
      }>;
    const o = await check(1, { order: ['w', 'r', 't'] });
    expect(o.question).toMatchObject({ state: 'COMPLETE', feedback: { texts: ['Отлично'] } });
    expect((await check(2, { gaps: { 1: 'c2', 2: 'c1', 3: 'c3' } })).question.state).toBe(
      'COMPLETE',
    );
    const d = await check(3, { gaps: { 1: 'c2', 2: 'c3' } });
    expect(d.question).toMatchObject({
      state: 'TRYAGAIN',
      feedback: { numCorrect: { right: 1, total: 2 } },
    });
    const again = (await runModuleAction(s1, quizId, 'tryAgain', { attemptId, slot: 3 })) as {
      question: { response: unknown };
    };
    expect(again.question.response).toEqual({ gaps: { 2: 'c3' } });
    await check(3, { gaps: { 1: 'c1', 2: 'c3' } });
    await runModuleAction(s1, quizId, 'finish', { attemptId });

    const at = await t.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    // gap 1 wrong once: 1 − ⅓; gap 2 right throughout → (⅔ + 1) / 2
    expect(Number(at.sumGrades)).toBeCloseTo(1 + 1 + (2 / 3 + 1) / 2, 4);
    const review = (await runModuleQuery(s1, quizId, 'review', { attemptId })) as {
      questions: { answerText: string; partScores: { fraction: number | null }[] | null }[];
    };
    expect(review.questions[0]!.answerText).toBe('Написать → Выполнить → Проверить');
    expect(review.questions[0]!.partScores!.map((p) => p.fraction)).toEqual([1, 1, 1]);
    expect(review.questions[1]!.answerText).toBe(
      '[tuple] неизменяемый, [list] изменяемый, [dict] — словарь',
    );
    expect(review.questions[2]!.partScores).toBeNull();
  });

  it('Cloze: answers written in the text, read when it is saved', async () => {
    const f = await courseFixture(t.db, 'QQT2');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const [cat] = await listQuestionCategories(teacher, f.courseId);
    const save = (text: string) =>
      saveQuestion.run(teacher, {
        categoryId: cat!.id,
        type: 'MULTIANSWER',
        name: 'Cloze',
        text,
        defaultMark: 4,
        data: {},
      } as never);
    await expect(save('<p>Столица — {1:SA:Лион}</p>')).rejects.toMatchObject({
      fieldErrors: { text: ['Gap 1: no right answer'] },
    });
    const { id } = await save(
      '<p>Столица Франции — {1:SA:=Париж#Верно}, 2 + 2 = {1:NM:=4}, список — {2:MCV:=list~tuple}.</p>',
    );
    const q = await t.db.question.findUniqueOrThrow({ where: { id } });
    expect(q.data).toMatchObject({
      parts: [{ kind: 'shortanswer' }, { kind: 'numerical' }, { kind: 'multichoice', weight: 2 }],
    });
    const quizId = (await f.addActivity('quiz', 'Cloze', { attempts: 0, behaviour: 'immediate' }))
      .id;
    await runModuleAction(teacher, quizId, 'addQuestions', { questionIds: [id] });
    const s1 = await ctxFor(t.db, f.users.student1!);
    const { attemptId } = (await runModuleAction(s1, quizId, 'start', {})) as {
      attemptId: string;
    };
    const attempt = (await runModuleQuery(s1, quizId, 'attempt', { attemptId })) as {
      questions: { text: string; clozeParts: { kind: string; options?: { id: string }[] }[] }[];
    };
    const [cq] = attempt.questions;
    expect(cq!.text).toBe('<p>Столица Франции — [[1]], 2 + 2 = [[2]], список — [[3]].</p>');
    expect(cq!.clozeParts.map((p) => p.kind)).toEqual(['shortanswer', 'numerical', 'multichoice']);
    expect(JSON.stringify(attempt)).not.toMatch(/Париж|Верно/);
    const checked = (await runModuleAction(s1, quizId, 'check', {
      attemptId,
      slot: 1,
      response: { parts: { 1: 'париж', 2: '5', 3: 'a1' } },
    })) as { question: { feedback: { verdict: string; mark: number } } };
    // 1 + 0 + 2 of 4 marks
    expect(checked.question.feedback).toMatchObject({ verdict: 'partial', mark: 3 });
    await runModuleAction(s1, quizId, 'finish', { attemptId });
    const review = (await runModuleQuery(s1, quizId, 'review', { attemptId })) as {
      questions: { text: string; answerText: string }[];
    };
    expect(review.questions[0]!.text).not.toContain('Париж');
    expect(review.questions[0]!.answerText).toBe(
      'Столица Франции — [париж], 2 + 2 = [5], список — [list].',
    );
  });
});
