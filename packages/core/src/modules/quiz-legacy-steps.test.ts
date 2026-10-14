import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type QuestionSnapshot, replay } from '@hubium/questions';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { importGift, saveQuestion } from '../questions/bank.ts';
import { runModuleAction } from './actions.ts';

// Attempts made before question behaviours had no steps: the migration that added them
// made steps from what was stored. Replayed, those steps must give the stored grades, so
// a regrade changes nothing.

const MIGRATION = path.resolve(
  import.meta.dirname,
  '../../../db/prisma/migrations/20261015120000_question_behaviours/migration.sql',
);

const GIFT = `
::А:: 2 + 2 = ? {=4 ~3 ~5}

::Б:: Земля круглая {T}

::В:: Столица Франции {=Париж =%50%Paris}

::Г:: 7 × 6 {#42:0.5}

::Д:: Пары {=кот -> мяу =собака -> гав =корова -> му}

::Е:: Простые числа {~%50%2 ~%50%3 ~%-100%4}
`;

describe('steps of attempts made before behaviours', () => {
  const t = useTestDb();

  it('replay to the stored grades, so a dry-run regrade changes nothing', async () => {
    const f = await courseFixture(t.db, 'QLEG');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await importGift.run(teacher, { courseId: f.courseId, gift: GIFT });
    const cat = await t.db.questionCategory.findFirstOrThrow({
      where: { contextId: f.courseId, parentId: null },
    });
    await saveQuestion.run(teacher, {
      categoryId: cat.id,
      type: 'ESSAY',
      name: 'Ж эссе',
      text: '<p>Опишите лето</p>',
      defaultMark: 2,
      data: {},
    } as never);
    const quizId = (await f.addActivity('quiz', 'Старый тест', { attempts: 0, perPage: 0 })).id;
    const qs = await t.db.question.findMany({
      where: { category: { contextId: f.courseId } },
      orderBy: { name: 'asc' },
    });
    await runModuleAction(teacher, quizId, 'addQuestions', { questionIds: qs.map((q) => q.id) });

    const answers = [
      // all right (multichoice ids follow the GIFT order: a1 is the right one)
      {
        1: { selected: ['a1'] },
        2: { value: true },
        3: { text: 'париж' },
        4: { text: '42.4' },
        5: { choices: {} },
        6: { selected: ['a1', 'a2'] },
        7: { text: '<p>Тёплое</p>' },
      },
      // some wrong, some partial, some left out
      {
        1: { selected: ['a2'] },
        3: { text: 'Paris' },
        4: { text: '41' },
        6: { selected: ['a1', 'a3'] },
      },
      {},
    ];
    for (const [k, user] of ['student1', 'student2', 'student3'].entries()) {
      const s = await ctxFor(t.db, f.users[user]!);
      const { attemptId } = (await runModuleAction(s, quizId, 'start', {})) as {
        attemptId: string;
      };
      await runModuleAction(s, quizId, 'finish', { attemptId, answers: answers[k] });
    }
    // a teacher's marks: the essay, and an automatic mark changed by hand
    const graded = await t.db.questionAttempt.findMany({
      where: { attempt: { activityId: quizId }, slot: { in: [7, 4] } },
      include: { attempt: true },
    });
    for (const qa of graded.filter((x) => x.attempt.userId === f.users.student1))
      await runModuleAction(teacher, quizId, 'gradeQuestion', {
        questionAttemptId: qa.id,
        mark: qa.slot === 7 ? 1.5 : 0.25,
      });
    const stored = await t.db.questionAttempt.findMany({
      where: { attempt: { activityId: quizId } },
      orderBy: [{ attemptId: 'asc' }, { slot: 'asc' }],
    });

    // back to the state before the migration, then its backfill
    await t.db.questionAttemptStep.deleteMany({});
    await t.db.questionAttempt.updateMany({ data: { tries: 0, state: 'TODO' } });
    const sql = readFileSync(MIGRATION, 'utf8');
    const backfill = sql.slice(sql.indexOf('-- The steps of earlier attempts'));
    for (const statement of backfill
      .split(/;\s*\n/)
      .filter((s) => /\S/.test(s.replace(/--.*$/gm, ''))))
      await t.db.$executeRawUnsafe(statement);

    const rows = await t.db.questionAttempt.findMany({
      where: { attempt: { activityId: quizId } },
      orderBy: [{ attemptId: 'asc' }, { slot: 'asc' }],
      include: { steps: { orderBy: { seq: 'asc' } } },
    });
    expect(rows).toHaveLength(21);
    for (const [k, qa] of rows.entries()) {
      expect(qa.state).toBe('COMPLETE');
      const o = replay(
        qa.snapshot as unknown as QuestionSnapshot,
        qa.steps.map((s) => ({
          kind: s.kind,
          response: s.response ?? undefined,
          fraction: s.fraction === null ? null : Number(s.fraction),
        })),
        'deferred',
      );
      const before = stored[k]!;
      expect([qa.slot, o.fraction]).toEqual([
        qa.slot,
        before.fraction === null ? null : Number(before.fraction),
      ]);
      expect(o.needsGrading).toBe(before.needsGrading);
    }
    const report = (await runModuleAction(teacher, quizId, 'regrade', { dryRun: true })) as {
      attempts: { before: number; after: number; maxBefore: number; maxAfter: number }[];
    };
    expect(report.attempts).toHaveLength(3);
    for (const a of report.attempts) {
      expect(a.after).toBe(a.before);
      expect(a.maxAfter).toBe(a.maxBefore);
    }
  });
});
