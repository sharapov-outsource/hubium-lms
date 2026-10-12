import type { Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { type ActivityRef, defineAction, defineModule, type ModuleCtx } from '@hubium/module-sdk';
import { bool, isoDate, optionalNumber } from '@hubium/module-sdk/fields';
import {
  gradeResponse,
  presentQuestion,
  type QuestionData,
  type QuestionSnapshot,
  type QuestionType,
  ResponseSchemas,
  shuffle,
  subSeed,
} from '@hubium/questions';
import { z } from 'zod';

// mod-quiz: question slots (fixed or random from a category), timed attempts with
// frozen question snapshots, automatic grading and manual grading of essays.

export const QuizSettings = z
  .object({
    openAt: isoDate,
    closeAt: isoDate,
    timeLimitMin: z.coerce
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .default(0),
    attempts: z.coerce.number().int().min(0).max(100).default(1),
    gradeMethod: z.enum(['HIGHEST', 'AVERAGE', 'FIRST', 'LAST']).default('HIGHEST'),
    shuffleQuestions: bool(false),
    shuffleAnswers: bool(true),
    perPage: z.coerce.number().int().min(0).max(100).default(1),
    gradeMax: z.coerce.number().min(1).max(10_000).default(10),
    gradePass: optionalNumber(0, 10_000),
    reviewAnswers: z.enum(['immediately', 'afterClose', 'never']).default('immediately'),
    reviewMarks: bool(true),
  })
  .refine((s) => !s.closeAt || !s.openAt || s.closeAt > s.openAt, {
    message: 'Close date must be after open date',
    path: ['closeAt'],
  })
  .refine((s) => s.gradePass === undefined || s.gradePass <= s.gradeMax, {
    message: 'Pass grade exceeds maximum',
    path: ['gradePass'],
  });

export type QuizSettingsT = z.output<typeof QuizSettings>;

/** Grace period for network delays after the time limit. */
export const GRACE_MS = 60_000;

type Db = Prisma.TransactionClient;

function uid(ctx: ModuleCtx): string {
  if (ctx.actor.kind !== 'user') throw new Error('Sign in required');
  return ctx.actor.userId;
}

export async function effectiveQuiz(db: Db, a: ActivityRef<QuizSettingsT>, userId: string) {
  const o = await db.quizOverride.findUnique({
    where: { activityId_userId: { activityId: a.id, userId } },
  });
  const d = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    openAt: o?.openAt ?? d(a.settings.openAt),
    closeAt: o?.closeAt ?? d(a.settings.closeAt),
    timeLimitSec: o?.timeLimitSec ?? a.settings.timeLimitMin * 60,
    attempts: o?.attempts ?? a.settings.attempts,
  };
}

export function quizIsOpen(e: { openAt: Date | null; closeAt: Date | null }, now: Date) {
  if (e.openAt && now < e.openAt) return { ok: false as const, reason: 'notOpen' as const };
  if (e.closeAt && now >= e.closeAt) return { ok: false as const, reason: 'closed' as const };
  return { ok: true as const };
}

export async function slotsWithQuestions(db: Db, activityId: string) {
  return db.quizSlot.findMany({
    where: { activityId },
    orderBy: { slot: 'asc' },
    include: { question: true, category: true },
  });
}

/** Total of slot maximum marks (the denominator of an attempt's grade). */
export function sumMaxMarks(slots: { maxMark: Prisma.Decimal | number }[]): number {
  return slots.reduce((s, x) => s + Number(x.maxMark), 0);
}

function snapshotOf(q: {
  id: string;
  type: string;
  name: string;
  text: string;
  generalFeedback: string;
  defaultMark: Prisma.Decimal;
  data: unknown;
}) {
  return {
    id: q.id,
    type: q.type as QuestionType,
    name: q.name,
    text: q.text,
    generalFeedback: q.generalFeedback,
    defaultMark: Number(q.defaultMark),
    data: q.data as QuestionData,
  };
}

async function categoryIds(db: Db, categoryId: string, includeSub: boolean): Promise<string[]> {
  if (!includeSub) return [categoryId];
  const out = [categoryId];
  let frontier = [categoryId];
  while (frontier.length) {
    const kids = await db.questionCategory.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = kids.map((k) => k.id);
    out.push(...frontier);
  }
  return out;
}

/** Creates an attempt: orders slots, draws random questions and freezes snapshots. */
export async function startAttempt(
  ctx: ModuleCtx,
  a: ActivityRef<QuizSettingsT>,
  userId: string,
  preview: boolean,
) {
  const slots = await slotsWithQuestions(ctx.db, a.id);
  if (!slots.length) throw new Error('This quiz has no questions yet');
  const e = await effectiveQuiz(ctx.db, a, userId);
  const last = await ctx.db.quizAttempt.findFirst({
    where: { activityId: a.id, userId, preview },
    orderBy: { attemptNumber: 'desc' },
  });
  const seed = Math.floor(Math.random() * 2 ** 31);
  const order = a.settings.shuffleQuestions ? shuffle(slots, seed) : slots;
  const used = new Set(slots.filter((s) => s.questionId).map((s) => s.questionId!));
  const timeDue = e.timeLimitSec ? new Date(ctx.now.getTime() + e.timeLimitSec * 1000) : null;
  const dueAt =
    timeDue && e.closeAt
      ? new Date(Math.min(timeDue.getTime(), e.closeAt.getTime()))
      : (timeDue ?? e.closeAt);
  const attempt = await ctx.db.quizAttempt.create({
    data: {
      activityId: a.id,
      userId,
      attemptNumber: (last?.attemptNumber ?? 0) + 1,
      dueAt: preview ? timeDue : dueAt,
      preview,
      seed,
    },
  });
  const perPage = a.settings.perPage || order.length;
  for (const [i, s] of order.entries()) {
    let q = s.question;
    if (s.kind === 'RANDOM' && s.categoryId) {
      const pool = await ctx.db.question.findMany({
        where: {
          categoryId: { in: await categoryIds(ctx.db, s.categoryId, s.includeSubcats) },
          status: 'READY',
          type: { not: 'DESCRIPTION' },
          id: { notIn: [...used] },
        },
      });
      if (!pool.length) throw new Error('Not enough questions in the random category');
      q = shuffle(pool, subSeed(seed, i))[0]!;
      used.add(q.id);
    }
    if (!q) throw new Error('Question missing');
    const snap = presentQuestion(snapshotOf(q), subSeed(seed, i), a.settings.shuffleAnswers);
    await ctx.db.questionAttempt.create({
      data: {
        attemptId: attempt.id,
        slot: i + 1,
        page: Math.floor(i / perPage) + 1,
        questionId: q.id,
        snapshot: snap as unknown as Prisma.InputJsonValue,
        maxMark: q.type === 'DESCRIPTION' ? 0 : s.maxMark,
      },
    });
  }
  return attempt;
}

async function ownAttempt(ctx: ModuleCtx, a: ActivityRef, attemptId: string) {
  const at = await ctx.db.quizAttempt.findUnique({ where: { id: attemptId } });
  if (!at || at.activityId !== a.id || at.userId !== uid(ctx)) throw new Error('Attempt not found');
  return at;
}

function cleanResponse(type: QuestionType, raw: unknown) {
  const r = ResponseSchemas[type].safeParse(raw ?? {});
  if (!r.success) return null;
  if (type === 'ESSAY') return { text: sanitizeRichText((r.data as { text: string }).text) };
  return r.data;
}

async function saveResponses(
  ctx: ModuleCtx,
  attemptId: string,
  answers: Record<string, unknown>,
  flags?: Record<string, boolean>,
) {
  const qas = await ctx.db.questionAttempt.findMany({ where: { attemptId } });
  for (const qa of qas) {
    const key = String(qa.slot);
    const data: Prisma.QuestionAttemptUpdateInput = {};
    if (key in answers) {
      const snap = qa.snapshot as unknown as QuestionSnapshot;
      const resp = cleanResponse(snap.type, answers[key]);
      if (resp) data.response = resp as Prisma.InputJsonValue;
    }
    if (flags && key in flags) data.flagged = !!flags[key];
    if (Object.keys(data).length)
      await ctx.db.questionAttempt.update({ where: { id: qa.id }, data });
  }
}

/** Grades every question of an attempt and closes it. */
export async function finishAttempt(
  ctx: ModuleCtx,
  a: ActivityRef<QuizSettingsT>,
  attemptId: string,
  state: 'FINISHED' | 'ABANDONED' = 'FINISHED',
) {
  const qas = await ctx.db.questionAttempt.findMany({ where: { attemptId } });
  let sum = 0;
  let manual = false;
  for (const qa of qas) {
    const snap = qa.snapshot as unknown as QuestionSnapshot;
    const r = gradeResponse(snap, qa.response);
    const max = Number(qa.maxMark);
    const mark = r.fraction === null ? null : r.fraction * max;
    if (r.needsGrading) manual = true;
    if (mark !== null) sum += mark;
    await ctx.db.questionAttempt.update({
      where: { id: qa.id },
      data: { fraction: r.fraction, mark, needsGrading: r.needsGrading },
    });
  }
  const at = await ctx.db.quizAttempt.update({
    where: { id: attemptId },
    data: { state, finishedAt: ctx.now, sumGrades: sum, needsManualGrading: manual },
  });
  if (!at.preview) await updateQuizGrade(ctx, a, at.userId);
  return at;
}

/** Recomputes the user's quiz grade from finished attempts using the grading method. */
export async function updateQuizGrade(
  ctx: ModuleCtx,
  a: ActivityRef<QuizSettingsT>,
  userId: string,
) {
  const attempts = await ctx.db.quizAttempt.findMany({
    where: { activityId: a.id, userId, preview: false, state: 'FINISHED' },
    orderBy: { attemptNumber: 'asc' },
    include: { questions: { select: { maxMark: true } } },
  });
  const graded = attempts.filter((x) => !x.needsManualGrading && x.sumGrades !== null);
  let grade: number | null = null;
  if (graded.length) {
    const scores = graded.map((x) => {
      const max = sumMaxMarks(x.questions);
      return max > 0 ? (Number(x.sumGrades) / max) * a.settings.gradeMax : 0;
    });
    switch (a.settings.gradeMethod) {
      case 'HIGHEST':
        grade = Math.max(...scores);
        break;
      case 'AVERAGE':
        grade = scores.reduce((s, x) => s + x, 0) / scores.length;
        break;
      case 'FIRST':
        grade = scores[0]!;
        break;
      case 'LAST':
        grade = scores.at(-1)!;
        break;
    }
  }
  if (grade !== null || attempts.length) {
    await ctx.grades.setGrades(a.id, [
      { userId, rawGrade: grade === null ? null : Math.round(grade * 100000) / 100000 },
    ]);
  }
  await ctx.completion.recompute(a.id, userId);
}

/** Can the learner see correct answers and feedback for this attempt now? */
export function reviewAllowed(s: QuizSettingsT, closeAt: Date | null, now: Date): boolean {
  if (s.reviewAnswers === 'never') return false;
  if (s.reviewAnswers === 'afterClose') return !!closeAt && now >= closeAt;
  return true;
}

export const quiz = defineModule<QuizSettingsT>({
  key: 'quiz',
  archetype: 'activity',
  icon: 'ListChecks',
  supports: { grading: true, groups: true, viewCompletion: true, backup: true },
  ai: {
    // Questions never reach the tutor, and the tutor is off while an attempt is open.
    tutorPolicy: 'exclude-while-open',
    async blocksTutor(ctx, a, userId) {
      const open = await ctx.db.quizAttempt.count({
        where: { activityId: a.id, userId, state: 'IN_PROGRESS' },
      });
      return open > 0;
    },
  },
  privacy: {
    // Attempts stay (they feed grades and statistics) and point at the anonymised user.
    async export(ctx, userId) {
      return ctx.db.quizAttempt.findMany({
        where: { userId, preview: false },
        select: {
          activityId: true,
          attemptNumber: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          sumGrades: true,
        },
      });
    },
  },
  backup: {
    async export(ctx, a) {
      const slots = await ctx.db.quizSlot.findMany({
        where: { activityId: a.id },
        orderBy: { slot: 'asc' },
      });
      return {
        slots: slots.map((s) => ({
          page: s.page,
          slot: s.slot,
          kind: s.kind,
          questionId: s.questionId,
          categoryId: s.categoryId,
          includeSubcats: s.includeSubcats,
          maxMark: Number(s.maxMark),
        })),
      };
    },
    async import(ctx, a, data, map) {
      const slots =
        (
          data as {
            slots?: {
              page: number;
              slot: number;
              kind: 'FIXED' | 'RANDOM';
              questionId: string | null;
              categoryId: string | null;
              includeSubcats: boolean;
              maxMark: number;
            }[];
          }
        ).slots ?? [];
      for (const s of slots) {
        const questionId = s.questionId ? map(s.questionId) : null;
        const categoryId = s.categoryId ? map(s.categoryId) : null;
        if (s.kind === 'FIXED' && !questionId) continue;
        if (s.kind === 'RANDOM' && !categoryId) continue;
        await ctx.db.quizSlot.create({
          data: {
            activityId: a.id,
            page: s.page,
            slot: s.slot,
            kind: s.kind,
            questionId,
            categoryId,
            includeSubcats: s.includeSubcats,
            maxMark: s.maxMark,
          },
        });
      }
    },
  },
  notifications: {
    needsGrading: { email: 'DIGEST' },
    graded: { email: 'IMMEDIATE' },
  },
  settings: {
    schema: QuizSettings as unknown as z.ZodType<QuizSettingsT>,
    defaults: () => QuizSettings.parse({}),
  },
  grading: {
    items: (a) => [
      { itemNumber: 0, name: '', gradeMax: a.settings.gradeMax, gradePass: a.settings.gradePass },
    ],
  },
  calendar: {
    events: (a) => [
      ...(a.settings.openAt
        ? [{ kind: 'OPEN' as const, title: a.name, startsAt: new Date(a.settings.openAt) }]
        : []),
      ...(a.settings.closeAt
        ? [{ kind: 'CLOSE' as const, title: a.name, startsAt: new Date(a.settings.closeAt) }]
        : []),
    ],
  },
  completion: {
    schema: z.object({ attempted: bool(false), pass: bool(false) }),
    async evaluate(ctx, a, userId, rules) {
      const finished = await ctx.db.quizAttempt.count({
        where: { activityId: a.id, userId, preview: false, state: 'FINISHED' },
      });
      if (rules.attempted && !finished) return 'incomplete';
      if (rules.pass) {
        const item = await ctx.db.gradeItem.findFirst({
          where: { activityId: a.id, itemNumber: 0 },
        });
        const g = item
          ? await ctx.db.grade.findUnique({
              where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
            })
          : null;
        if (g?.finalGrade === null || g?.finalGrade === undefined) return 'incomplete';
        if (item?.gradePass !== null && item?.gradePass !== undefined)
          return Number(g.finalGrade) >= Number(item.gradePass) ? 'pass' : 'fail';
      }
      return 'complete';
    },
  },
  actions: {
    // ── editing ──
    addQuestions: defineAction({
      capability: 'course:manageactivities',
      input: z.object({ questionIds: z.array(z.string().uuid()).min(1).max(200) }),
      async handler(ctx, a, { questionIds }) {
        if (await ctx.db.quizAttempt.count({ where: { activityId: a.id, preview: false } }))
          throw new Error('Cannot change questions after attempts exist');
        const last = await ctx.db.quizSlot.findFirst({
          where: { activityId: a.id },
          orderBy: { slot: 'desc' },
        });
        let n = last?.slot ?? 0;
        const qs = await ctx.db.question.findMany({
          where: { id: { in: questionIds }, category: { contextId: a.courseId } },
        });
        for (const id of questionIds) {
          const q = qs.find((x) => x.id === id);
          if (!q) continue;
          await ctx.db.quizSlot.create({
            data: {
              activityId: a.id,
              slot: ++n,
              kind: 'FIXED',
              questionId: q.id,
              maxMark: q.defaultMark,
            },
          });
        }
        return { slots: n };
      },
    }),
    addRandom: defineAction({
      capability: 'course:manageactivities',
      input: z.object({
        categoryId: z.string().uuid(),
        count: z.number().int().min(1).max(100),
        includeSubcats: z.boolean().default(false),
      }),
      async handler(ctx, a, input) {
        if (await ctx.db.quizAttempt.count({ where: { activityId: a.id, preview: false } }))
          throw new Error('Cannot change questions after attempts exist');
        const cat = await ctx.db.questionCategory.findFirst({
          where: { id: input.categoryId, contextId: a.courseId },
        });
        if (!cat) throw new Error('Category not found');
        const last = await ctx.db.quizSlot.findFirst({
          where: { activityId: a.id },
          orderBy: { slot: 'desc' },
        });
        let n = last?.slot ?? 0;
        for (let i = 0; i < input.count; i++) {
          await ctx.db.quizSlot.create({
            data: {
              activityId: a.id,
              slot: ++n,
              kind: 'RANDOM',
              categoryId: cat.id,
              includeSubcats: input.includeSubcats,
            },
          });
        }
        return { slots: n };
      },
    }),
    editSlot: defineAction({
      capability: 'course:manageactivities',
      input: z.object({
        slot: z.number().int().min(1),
        op: z.enum(['remove', 'up', 'down', 'mark']),
        maxMark: z.number().min(0).max(1000).optional(),
      }),
      async handler(ctx, a, input) {
        const slots = await ctx.db.quizSlot.findMany({
          where: { activityId: a.id },
          orderBy: { slot: 'asc' },
        });
        const i = slots.findIndex((s) => s.slot === input.slot);
        if (i < 0) throw new Error('Slot not found');
        const hasAttempts =
          (await ctx.db.quizAttempt.count({ where: { activityId: a.id, preview: false } })) > 0;
        if (input.op === 'mark') {
          await ctx.db.quizSlot.update({
            where: { id: slots[i]!.id },
            data: { maxMark: input.maxMark ?? 1 },
          });
          return { ok: true };
        }
        if (hasAttempts) throw new Error('Cannot change questions after attempts exist');
        let order = [...slots];
        if (input.op === 'remove') order.splice(i, 1);
        if (input.op === 'up' && i > 0) [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
        if (input.op === 'down' && i < order.length - 1)
          [order[i + 1], order[i]] = [order[i]!, order[i + 1]!];
        if (input.op === 'remove') await ctx.db.quizSlot.delete({ where: { id: slots[i]!.id } });
        order = order.filter((s) => input.op !== 'remove' || s.id !== slots[i]!.id);
        // Two passes to avoid unique (activityId, slot) collisions.
        for (const [k, s] of order.entries())
          await ctx.db.quizSlot.update({ where: { id: s.id }, data: { slot: 10_000 + k } });
        for (const [k, s] of order.entries())
          await ctx.db.quizSlot.update({ where: { id: s.id }, data: { slot: k + 1 } });
        return { ok: true };
      },
    }),
    // ── attempts ──
    start: defineAction({
      input: z.object({ preview: z.boolean().default(false) }),
      async handler(ctx, a, { preview }) {
        const userId = uid(ctx);
        const quizA = a as ActivityRef<QuizSettingsT>;
        if (preview) await ctx.perm.require('mod.quiz:preview', a.id);
        else await ctx.perm.require('mod.quiz:attempt', a.id);
        const open = await ctx.db.quizAttempt.findFirst({
          where: { activityId: a.id, userId, preview, state: 'IN_PROGRESS' },
        });
        if (open) return { attemptId: open.id };
        if (!preview) {
          const e = await effectiveQuiz(ctx.db, quizA, userId);
          const w = quizIsOpen(e, ctx.now);
          if (!w.ok)
            throw new Error(
              w.reason === 'notOpen' ? 'The quiz is not open yet' : 'The quiz is closed',
            );
          const done = await ctx.db.quizAttempt.count({
            where: { activityId: a.id, userId, preview: false },
          });
          if (e.attempts && done >= e.attempts) throw new Error('No attempts left');
        }
        const at = await startAttempt(ctx, quizA, userId, preview);
        await ctx.log('quiz.attempt.started', { activityId: a.id, attemptId: at.id });
        return { attemptId: at.id };
      },
    }),
    save: defineAction({
      input: z.object({
        attemptId: z.string().uuid(),
        answers: z.record(z.string(), z.unknown()).default({}),
        flags: z.record(z.string(), z.boolean()).optional(),
      }),
      async handler(ctx, a, input) {
        const at = await ownAttempt(ctx, a, input.attemptId);
        if (at.state !== 'IN_PROGRESS') throw new Error('This attempt is closed');
        if (at.dueAt && ctx.now.getTime() > at.dueAt.getTime() + GRACE_MS) {
          await finishAttempt(ctx, a as ActivityRef<QuizSettingsT>, at.id);
          throw new Error('Time is up; the attempt was submitted');
        }
        await saveResponses(ctx, at.id, input.answers, input.flags);
        return { savedAt: ctx.now.toISOString() };
      },
    }),
    finish: defineAction({
      input: z.object({
        attemptId: z.string().uuid(),
        answers: z.record(z.string(), z.unknown()).default({}),
      }),
      async handler(ctx, a, input) {
        const at = await ownAttempt(ctx, a, input.attemptId);
        if (at.state !== 'IN_PROGRESS') return { attemptId: at.id };
        const late = at.dueAt && ctx.now.getTime() > at.dueAt.getTime() + GRACE_MS;
        if (!late) await saveResponses(ctx, at.id, input.answers);
        await finishAttempt(ctx, a as ActivityRef<QuizSettingsT>, at.id);
        await ctx.log('quiz.attempt.finished', { activityId: a.id, attemptId: at.id });
        if (!at.preview) {
          const graders = await ctx.perm.usersWithCap('mod.quiz:grade', a.id);
          const needs = await ctx.db.quizAttempt.findUnique({
            where: { id: at.id },
            select: { needsManualGrading: true },
          });
          if (needs?.needsManualGrading) {
            await ctx.notify.send(graders, {
              type: 'quiz.needsGrading',
              title: { key: 'mod.quiz.notify.needsGradingTitle', values: { name: a.name } },
              url: `/course/${a.courseId}/a/${a.id}?tab=grading`,
              courseId: a.courseId,
              contextId: a.id,
            });
          }
        }
        return { attemptId: at.id };
      },
    }),
    gradeQuestion: defineAction({
      capability: 'mod.quiz:grade',
      input: z.object({
        questionAttemptId: z.string().uuid(),
        mark: z.number().min(0),
        comment: z.string().max(20_000).default(''),
      }),
      async handler(ctx, a, input) {
        const qa = await ctx.db.questionAttempt.findUnique({
          where: { id: input.questionAttemptId },
          include: { attempt: true },
        });
        if (!qa || qa.attempt.activityId !== a.id) throw new Error('Not found');
        if (qa.attempt.state !== 'FINISHED') throw new Error('The attempt is not finished');
        const max = Number(qa.maxMark);
        if (input.mark > max) throw new Error(`Mark must be at most ${max}`);
        await ctx.db.questionAttempt.update({
          where: { id: qa.id },
          data: {
            mark: input.mark,
            fraction: max ? input.mark / max : 0,
            needsGrading: false,
            comment: sanitizeRichText(input.comment),
            gradedById: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
          },
        });
        const all = await ctx.db.questionAttempt.findMany({ where: { attemptId: qa.attemptId } });
        await ctx.db.quizAttempt.update({
          where: { id: qa.attemptId },
          data: {
            sumGrades: all.reduce((s, x) => s + Number(x.mark ?? 0), 0),
            needsManualGrading: all.some((x) => x.needsGrading),
          },
        });
        if (!qa.attempt.preview) {
          await updateQuizGrade(ctx, a as ActivityRef<QuizSettingsT>, qa.attempt.userId);
          if (!all.some((x) => x.needsGrading)) {
            await ctx.notify.send([qa.attempt.userId], {
              type: 'quiz.graded',
              title: { key: 'mod.quiz.notify.gradedTitle', values: { name: a.name } },
              url: `/course/${a.courseId}/a/${a.id}?attempt=${qa.attemptId}`,
              courseId: a.courseId,
              contextId: a.id,
            });
          }
        }
        return { ok: true };
      },
    }),
  },
  async todo(ctx, userId, courseIds) {
    const acts = await ctx.db.activity.findMany({
      where: {
        moduleKey: 'quiz',
        courseId: { in: courseIds },
        deletedAt: null,
        visibility: 'SHOWN',
      },
    });
    const out = [];
    for (const a of acts) {
      if (await ctx.perm.can('mod.quiz:grade', a.id)) {
        const n = await ctx.db.quizAttempt.count({
          where: { activityId: a.id, needsManualGrading: true, state: 'FINISHED', preview: false },
        });
        if (n)
          out.push({
            activityId: a.id,
            courseId: a.courseId,
            title: a.name,
            kind: 'grade' as const,
            count: n,
          });
        continue;
      }
      if (!(await ctx.perm.can('mod.quiz:attempt', a.id))) continue;
      const s = QuizSettings.safeParse(a.settings);
      if (!s.success) continue;
      const done = await ctx.db.quizAttempt.count({
        where: { activityId: a.id, userId, preview: false },
      });
      const closeAt = s.data.closeAt ? new Date(s.data.closeAt) : null;
      if (done === 0 && (!closeAt || closeAt > ctx.now)) {
        out.push({
          activityId: a.id,
          courseId: a.courseId,
          title: a.name,
          kind: 'attempt' as const,
          dueAt: closeAt,
        });
      }
    }
    return out;
  },
  cron: [
    {
      name: 'quiz.overdue.sweep',
      schedule: '* * * * *',
      async handler(ctx) {
        // Closes attempts whose time ran out while the browser was closed.
        const due = await ctx.db.quizAttempt.findMany({
          where: { state: 'IN_PROGRESS', dueAt: { lt: new Date(ctx.now.getTime() - GRACE_MS) } },
          take: 200,
        });
        for (const at of due) {
          const act = await ctx.db.activity.findUnique({ where: { id: at.activityId } });
          if (!act) continue;
          const s = QuizSettings.safeParse(act.settings);
          if (!s.success) continue;
          await finishAttempt(
            ctx,
            { ...(act as never as ActivityRef<QuizSettingsT>), settings: s.data },
            at.id,
          );
        }
        return { closed: due.length };
      },
    },
  ],
});

export const quizModules = [quiz];
