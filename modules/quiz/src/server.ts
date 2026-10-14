import type { Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import {
  type ActivityRef,
  defineAction,
  defineModule,
  defineQuery,
  type ModuleCtx,
  ModuleError,
} from '@hubium/module-sdk';
import { bool, isoDate, optionalNumber } from '@hubium/module-sdk/fields';
import { invalidIpListEntries } from '@hubium/module-sdk/net';
import {
  type Behaviour,
  behaviours,
  clearWrongParts,
  correctResponse,
  type Dataset,
  datasetFromRow,
  datasetsFor,
  fillText,
  gradedTypes,
  type Hint,
  hashString,
  isAnswered,
  type Outcome,
  PublicFields,
  presentQuestion,
  type QuestionData,
  type QuestionSnapshot,
  type QuestionType,
  questionTypes,
  ResponseSchemas,
  replay,
  answerText as responseText,
  reviewParts,
  type Step,
  shuffle,
  subSeed,
  typeDef,
} from '@hubium/questions';
import { z } from 'zod';
import {
  type AccessRules,
  checkStart,
  effectivePasswords,
  networkAllowed,
  nextAttemptAt,
} from './access.ts';
import { type LiveState, type PublicQuestion, toPublicQuestion } from './public.ts';

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
    /** Asked before an attempt starts (previews too); '' for none. */
    password: z.string().max(255).default(''),
    /** Network addresses attempts may be taken from (see ipInList); '' for anywhere. */
    subnet: z
      .string()
      .trim()
      .max(2000)
      .default('')
      .superRefine((s, c) => {
        const bad = invalidIpListEntries(s);
        if (bad.length)
          c.addIssue({ code: 'custom', message: `Not an address: ${bad.join(', ')}` });
      }),
    /** Minutes to wait after the first attempt, and after each later one. */
    delay1Min: z.coerce
      .number()
      .int()
      .min(0)
      .max(366 * 24 * 60)
      .default(0),
    delay2Min: z.coerce
      .number()
      .int()
      .min(0)
      .max(366 * 24 * 60)
      .default(0),
    /** sequential: pages in order, no going back. */
    navMethod: z.enum(['free', 'sequential']).default('free'),
    /** How questions behave (see @hubium/questions behaviours). */
    behaviour: z.enum(behaviours).default('deferred'),
    /** After a check: the feedback for the answer and the hint (immediate, interactive). */
    duringFeedback: bool(true),
    /** After a question is complete: its right answer, during the attempt. */
    duringRightAnswer: bool(false),
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

type OverrideFields = {
  openAt: Date | null;
  closeAt: Date | null;
  timeLimitSec: number | null;
  attempts: number | null;
};

/**
 * Group overrides merged the way that favours the learner (as in Moodle): the earliest
 * opening, the latest closing, the longest time and the most attempts (0 = unlimited).
 */
export function lenientOverride(list: OverrideFields[]): OverrideFields {
  const pick = <T>(vals: (T | null)[], better: (a: T, b: T) => boolean): T | null =>
    vals.reduce<T | null>(
      (acc, v) => (v === null ? acc : acc === null || better(v, acc) ? v : acc),
      null,
    );
  const unlimitedFirst = (a: number, b: number) => a === 0 || (b !== 0 && a > b);
  return {
    openAt: pick(
      list.map((o) => o.openAt),
      (a, b) => a < b,
    ),
    closeAt: pick(
      list.map((o) => o.closeAt),
      (a, b) => a > b,
    ),
    timeLimitSec: pick(
      list.map((o) => o.timeLimitSec),
      unlimitedFirst,
    ),
    attempts: pick(
      list.map((o) => o.attempts),
      unlimitedFirst,
    ),
  };
}

/** The quiz settings that apply to one learner: their own override, then their groups'. */
export async function effectiveQuiz(db: Db, a: ActivityRef<QuizSettingsT>, userId: string) {
  const [own, groups] = await Promise.all([
    db.quizOverride.findUnique({ where: { activityId_userId: { activityId: a.id, userId } } }),
    db.quizOverride.findMany({
      where: { activityId: a.id, group: { members: { some: { userId } } } },
    }),
  ]);
  const g = lenientOverride(groups);
  const d = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    openAt: own?.openAt ?? g.openAt ?? d(a.settings.openAt),
    closeAt: own?.closeAt ?? g.closeAt ?? d(a.settings.closeAt),
    timeLimitSec: own?.timeLimitSec ?? g.timeLimitSec ?? a.settings.timeLimitMin * 60,
    attempts: own?.attempts ?? g.attempts ?? a.settings.attempts,
    passwords: effectivePasswords(
      a.settings.password,
      own?.password,
      groups.map((x) => x.password),
    ),
  };
}

/** Password, network and waiting rules for one learner. */
export function accessRules(
  a: ActivityRef<QuizSettingsT>,
  e: { passwords: string[] },
): AccessRules {
  return {
    passwords: e.passwords,
    subnet: a.settings.subnet,
    delay1Sec: a.settings.delay1Min * 60,
    delay2Sec: a.settings.delay2Min * 60,
  };
}

/** Attempts may only be taken (and continued) from the quiz's network addresses. */
function requireNetwork(ctx: ModuleCtx, a: ActivityRef<QuizSettingsT>) {
  if (!networkAllowed(a.settings, ctx.ip))
    throw new ModuleError(
      'FORBIDDEN',
      'This quiz can only be taken from certain network addresses',
    );
}

/**
 * Feedback on answers as HTML for the browser. It comes as plain text from the question
 * editor and GIFT and as HTML from Moodle, and is shown as HTML: always sanitised here.
 */
const feedbackHtml = (texts: string[]) =>
  texts.map((x) => sanitizeRichText(x)).filter((x) => x.trim());

/** What a question shows during an attempt in the immediate and interactive behaviours. */
export function liveState(
  s: QuizSettingsT,
  behaviour: Behaviour,
  qa: { snapshot: unknown; maxMark: unknown },
  steps: Step[],
): LiveState {
  const snap = qa.snapshot as QuestionSnapshot;
  const o = replay(snap, steps, behaviour);
  const auto = typeDef(snap.type).grading === 'auto';
  // feedback stays from a check until the next try starts
  const checked = auto && behaviour !== 'deferred' && o.tries > 0 && o.state !== 'TODO';
  const raw = o.rawFraction ?? 0;
  const right = o.state === 'COMPLETE' ? correctResponse(snap) : null;
  return {
    state: o.state,
    canCheck: auto && behaviour !== 'deferred' && o.state === 'TODO',
    triesLeft: auto && behaviour === 'interactive' ? Math.max(0, o.maxTries - o.tries) : null,
    feedback: checked
      ? {
          verdict: raw >= 0.9999 ? 'correct' : raw > 0 ? 'partial' : 'incorrect',
          mark: s.reviewMarks && o.fraction !== null ? o.fraction * Number(qa.maxMark) : null,
          texts: s.duringFeedback ? feedbackHtml(o.feedback) : [],
          hint: s.duringFeedback && o.hint ? sanitizeRichText(fillText(snap, o.hint.text)) : null,
          numCorrect: s.duringFeedback ? o.numCorrect : null,
          rightAnswer: s.duringRightAnswer && right ? answerText(snap, right) || null : null,
        }
      : null,
  };
}

// ── pages ───────────────────────────────────────────────────────────────────────

/** Page numbers made consecutive from 1, keeping their order. */
export function normalisePages(pages: number[]): number[] {
  const map = new Map([...new Set(pages)].sort((x, y) => x - y).map((p, i) => [p, i + 1]));
  return pages.map((p) => map.get(p)!);
}

/** The page of a slot added after `pages`: a new page every `perPage` questions. */
export function pageForNewSlot(pages: number[], perPage: number): number {
  const last = pages.at(-1);
  if (last === undefined) return 1;
  if (perPage <= 0) return last;
  return pages.filter((p) => p === last).length >= perPage ? last + 1 : last;
}

/** Pages of the quiz's slots in slot order. */
async function slotPages(db: Db, activityId: string): Promise<number[]> {
  const rows = await db.quizSlot.findMany({
    where: { activityId },
    orderBy: { slot: 'asc' },
    select: { page: true },
  });
  return rows.map((r) => r.page);
}

/** With sequential navigation answers are taken for the current page only. */
function currentPageOnly(
  a: ActivityRef<QuizSettingsT>,
  at: { currentPage: number },
): number | undefined {
  return a.settings.navMethod === 'sequential' ? at.currentPage : undefined;
}

/** Lays the slots out anew, `perPage` to a page (0: all on one page). */
async function repaginate(db: Db, activityId: string, perPage: number) {
  const slots = await db.quizSlot.findMany({ where: { activityId }, orderBy: { slot: 'asc' } });
  for (const [k, s] of slots.entries()) {
    const page = perPage > 0 ? Math.floor(k / perPage) + 1 : 1;
    if (s.page !== page) await db.quizSlot.update({ where: { id: s.id }, data: { page } });
  }
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
  penalty: Prisma.Decimal;
  hints: unknown;
  data: unknown;
}) {
  return {
    id: q.id,
    type: q.type as QuestionType,
    name: q.name,
    text: q.text,
    generalFeedback: q.generalFeedback,
    defaultMark: Number(q.defaultMark),
    penalty: Number(q.penalty),
    hints: (Array.isArray(q.hints) ? q.hints : []) as Hint[],
    data: q.data as QuestionData,
  };
}

// ── steps (behaviours) ───────────────────────────────────────────────────────────

type QaRow = {
  id: string;
  snapshot: Prisma.JsonValue;
  maxMark: Prisma.Decimal;
  response: Prisma.JsonValue;
  state: string;
};

const asStep = (s: { kind: string; response: unknown; fraction: unknown }): Step => ({
  kind: s.kind as Step['kind'],
  response: s.response === null ? undefined : s.response,
  fraction: s.fraction === null || s.fraction === undefined ? null : Number(s.fraction),
});

async function stepsOf(db: Db, questionAttemptId: string): Promise<Step[]> {
  const rows = await db.questionAttemptStep.findMany({
    where: { questionAttemptId },
    orderBy: { seq: 'asc' },
  });
  return rows.map(asStep);
}

async function addStep(
  db: Db,
  questionAttemptId: string,
  step: {
    kind: Step['kind'];
    response?: unknown;
    fraction?: number | null;
    userId?: string | null;
  },
) {
  const last = await db.questionAttemptStep.findFirst({
    where: { questionAttemptId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  await db.questionAttemptStep.create({
    data: {
      questionAttemptId,
      seq: (last?.seq ?? 0) + 1,
      kind: step.kind,
      ...(step.response === undefined ? {} : { response: step.response as Prisma.InputJsonValue }),
      fraction: step.fraction ?? null,
      userId: step.userId ?? null,
    },
  });
}

/** Replays a question's steps and stores its state and mark; returns the outcome. */
async function settle(
  db: Db,
  qa: QaRow,
  behaviour: Behaviour,
  snapshot: QuestionSnapshot = qa.snapshot as unknown as QuestionSnapshot,
  maxMark = Number(qa.maxMark),
): Promise<Outcome> {
  const o = replay(snapshot, await stepsOf(db, qa.id), behaviour);
  await db.questionAttempt.update({
    where: { id: qa.id },
    data: {
      fraction: o.fraction,
      mark: o.fraction === null ? null : o.fraction * maxMark,
      needsGrading: o.needsGrading,
      tries: o.tries,
      state: o.state,
      ...(o.response === null || o.response === undefined
        ? {}
        : { response: o.response as Prisma.InputJsonValue }),
    },
  });
  return o;
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
  // calculated questions draw from their own datasets and the ones their category shares
  const shared = new Map<string, Dataset[]>();
  const sharedIn = async (categoryId: string) => {
    if (!shared.has(categoryId))
      shared.set(
        categoryId,
        (await ctx.db.questionDataset.findMany({ where: { categoryId } })).map(datasetFromRow),
      );
    return shared.get(categoryId)!;
  };
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
      behaviour: a.settings.behaviour,
    },
  });
  // Shuffling moves questions between positions; each position keeps its slot's page.
  const pageAt = normalisePages(slots.map((s) => s.page));
  for (const [i, s] of order.entries()) {
    let q = s.question;
    if (s.kind === 'RANDOM' && s.categoryId) {
      const pool = await ctx.db.question.findMany({
        where: {
          categoryId: { in: await categoryIds(ctx.db, s.categoryId, s.includeSubcats) },
          status: 'READY',
          type: { in: gradedTypes },
          id: { notIn: [...used] },
        },
      });
      if (!pool.length) throw new Error('Not enough questions in the random category');
      q = shuffle(pool, subSeed(seed, i))[0]!;
      used.add(q.id);
    }
    if (!q) throw new Error('Question missing');
    let base = snapshotOf(q);
    if (base.data && 'datasets' in base.data) {
      const d = base.data as Parameters<typeof datasetsFor>[0];
      base = {
        ...base,
        data: { ...d, datasets: datasetsFor(d, await sharedIn(q.categoryId)) } as QuestionData,
      };
    }
    // synchronised questions of a category draw the same item in an attempt
    const snap = presentQuestion(base, subSeed(seed, i), a.settings.shuffleAnswers, {
      syncSeed: subSeed(seed, hashString(q.categoryId)),
    });
    await ctx.db.questionAttempt.create({
      data: {
        attemptId: attempt.id,
        slot: i + 1,
        page: pageAt[i]!,
        questionId: q.id,
        quizSlotId: s.id,
        snapshot: snap as unknown as Prisma.InputJsonValue,
        maxMark: typeDef(q.type as QuestionType).grading === 'none' ? 0 : s.maxMark,
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
  const out = { ...r.data } as Record<string, unknown>;
  for (const key of typeDef(type).richText ?? [])
    if (typeof out[key] === 'string') out[key] = sanitizeRichText(out[key]);
  return out;
}

async function saveResponses(
  ctx: ModuleCtx,
  attemptId: string,
  answers: Record<string, unknown>,
  flags?: Record<string, boolean>,
  /** Sequential navigation: answers are taken for this page only. */
  onlyPage?: number,
) {
  const qas = await ctx.db.questionAttempt.findMany({ where: { attemptId } });
  for (const qa of qas) {
    const key = String(qa.slot);
    const data: Prisma.QuestionAttemptUpdateInput = {};
    let changed: unknown;
    if (key in answers) {
      if (onlyPage !== undefined && qa.page !== onlyPage)
        throw new ModuleError('CONFLICT', 'That question is on a page you have already left');
      const snap = qa.snapshot as unknown as QuestionSnapshot;
      const resp = cleanResponse(snap.type, answers[key]);
      // A step only when the answer changed: autosave sends the same one again and again.
      // A checked question keeps its answer until the learner tries again.
      if (resp && qa.state === 'TODO' && JSON.stringify(resp) !== JSON.stringify(qa.response)) {
        data.response = resp as Prisma.InputJsonValue;
        changed = resp;
      }
    }
    if (flags && key in flags) data.flagged = !!flags[key];
    if (Object.keys(data).length)
      await ctx.db.questionAttempt.update({ where: { id: qa.id }, data });
    if (changed !== undefined) await addStep(ctx.db, qa.id, { kind: 'SAVE', response: changed });
  }
}

/**
 * One question of the learner's open attempt, for check and tryAgain. A late attempt is
 * finished instead (`closed`); with sequential navigation only the current page counts.
 */
async function questionInPlay(ctx: ModuleCtx, a: ActivityRef, attemptId: string, slot: number) {
  const quizA = a as ActivityRef<QuizSettingsT>;
  const at = await ownAttempt(ctx, a, attemptId);
  if (at.state !== 'IN_PROGRESS') throw new Error('This attempt is closed');
  requireNetwork(ctx, quizA);
  const closed = !!at.dueAt && ctx.now.getTime() > at.dueAt.getTime() + GRACE_MS;
  // Returned, not thrown: an error would roll the finishing back with the transaction.
  if (closed) await finishAttempt(ctx, quizA, at.id);
  const qa = await ctx.db.questionAttempt.findFirst({ where: { attemptId: at.id, slot } });
  if (!qa) throw new ModuleError('NOT_FOUND', 'No such question in the attempt');
  if (!closed && quizA.settings.navMethod === 'sequential' && qa.page !== at.currentPage)
    throw new ModuleError('CONFLICT', 'That question is on a page you have already left');
  const snap = qa.snapshot as unknown as QuestionSnapshot;
  return { quizA, at, qa, snap, behaviour: at.behaviour as Behaviour, closed };
}

/** A question of an attempt in progress as the player shows it. */
async function liveQuestion(
  db: Db,
  a: ActivityRef<QuizSettingsT>,
  at: { behaviour: string },
  questionAttemptId: string,
) {
  const qa = await db.questionAttempt.findUniqueOrThrow({
    where: { id: questionAttemptId },
    include: { steps: { orderBy: { seq: 'asc' } } },
  });
  return {
    ...toPublicQuestion(qa),
    ...liveState(a.settings, at.behaviour as Behaviour, qa, qa.steps.map(asStep)),
  };
}

/** Grades every question of an attempt and closes it. */
export async function finishAttempt(
  ctx: ModuleCtx,
  a: ActivityRef<QuizSettingsT>,
  attemptId: string,
  state: 'FINISHED' | 'ABANDONED' = 'FINISHED',
) {
  const [qas, attempt] = await Promise.all([
    ctx.db.questionAttempt.findMany({ where: { attemptId } }),
    ctx.db.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
  ]);
  let sum = 0;
  let manual = false;
  for (const qa of qas) {
    await addStep(ctx.db, qa.id, { kind: 'FINISH' });
    const o = await settle(ctx.db, qa, attempt.behaviour as Behaviour);
    if (o.needsGrading) manual = true;
    if (o.fraction !== null) sum += o.fraction * Number(qa.maxMark);
  }
  const at = await ctx.db.quizAttempt.update({
    where: { id: attemptId },
    data: { state, finishedAt: ctx.now, sumGrades: sum, needsManualGrading: manual },
  });
  if (!at.preview) await updateQuizGrade(ctx, a, at.userId);
  // Here rather than in the "finish" action: time-outs and the overdue sweep close attempts too.
  if (state === 'FINISHED')
    await ctx.log('quiz.attempt.finished', {
      activityId: a.id,
      attemptId: at.id,
      userId: at.userId,
      sumGrades: sum,
      preview: at.preview,
    });
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

export interface RegradeReport {
  attempts: {
    attemptId: string;
    userId: string;
    attemptNumber: number;
    before: number;
    after: number;
    maxBefore: number;
    maxAfter: number;
  }[];
  /** Questions whose type changed since the attempt: their marks were kept. */
  skipped: string[];
}

/**
 * Regrades finished attempts with the current version of each question and the current
 * marks of the slots. Manually graded answers and essays keep their marks. With dryRun
 * nothing is written.
 */
export async function regradeQuiz(
  ctx: ModuleCtx,
  a: ActivityRef<QuizSettingsT>,
  dryRun: boolean,
): Promise<RegradeReport> {
  const attempts = await ctx.db.quizAttempt.findMany({
    where: { activityId: a.id, state: 'FINISHED', preview: false },
    orderBy: [{ userId: 'asc' }, { attemptNumber: 'asc' }],
    include: { questions: { include: { steps: { orderBy: { seq: 'asc' } } } } },
  });
  const ids = [...new Set(attempts.flatMap((x) => x.questions.map((q) => q.questionId)))];
  const [questions, slots] = await Promise.all([
    ctx.db.question.findMany({ where: { id: { in: ids } } }),
    ctx.db.quizSlot.findMany({ where: { activityId: a.id } }),
  ]);
  const report: RegradeReport = { attempts: [], skipped: [] };
  const touched = new Set<string>();
  for (const at of attempts) {
    let before = 0;
    let after = 0;
    let maxBefore = 0;
    let maxAfter = 0;
    const updates: { id: string; data: Prisma.QuestionAttemptUpdateInput }[] = [];
    for (const qa of at.questions) {
      const snap = qa.snapshot as unknown as QuestionSnapshot;
      const mark = qa.mark === null ? 0 : Number(qa.mark);
      before += mark;
      maxBefore += Number(qa.maxMark);
      const q = questions.find((x) => x.id === qa.questionId);
      const slot = slots.find((x) => x.id === qa.quizSlotId);
      const maxMark =
        typeDef(snap.type).grading === 'none'
          ? 0
          : slot
            ? Number(slot.maxMark)
            : Number(qa.maxMark);
      maxAfter += maxMark;
      // a question that changed type cannot be graded again: its mark is kept, scaled
      if (!q || q.type !== snap.type) {
        if (q && q.type !== snap.type && !report.skipped.includes(q.name))
          report.skipped.push(q.name);
        const scaled = Number(qa.maxMark) > 0 ? (mark / Number(qa.maxMark)) * maxMark : 0;
        after += qa.mark === null ? 0 : scaled;
        if (maxMark !== Number(qa.maxMark))
          updates.push({
            id: qa.id,
            data: { maxMark, ...(qa.mark === null ? {} : { mark: scaled }) },
          });
        continue;
      }
      // The current question, presented as the learner saw it (order of choices kept),
      // through the same steps: a teacher's mark stays, scaled to a changed maximum.
      const fresh = { ...snap, ...snapshotOf(q) } as QuestionSnapshot;
      const o = replay(fresh, qa.steps.map(asStep), at.behaviour as Behaviour);
      const newMark = o.fraction === null ? null : o.fraction * maxMark;
      after += newMark ?? 0;
      updates.push({
        id: qa.id,
        data: {
          snapshot: fresh as unknown as Prisma.InputJsonValue,
          maxMark,
          fraction: o.fraction,
          mark: newMark,
          needsGrading: o.needsGrading,
          tries: o.tries,
          state: o.state,
        },
      });
    }
    report.attempts.push({
      attemptId: at.id,
      userId: at.userId,
      attemptNumber: at.attemptNumber,
      before: Math.round(before * 1e5) / 1e5,
      after: Math.round(after * 1e5) / 1e5,
      maxBefore,
      maxAfter,
    });
    if (dryRun) continue;
    for (const u of updates)
      await ctx.db.questionAttempt.update({ where: { id: u.id }, data: u.data });
    const all = await ctx.db.questionAttempt.findMany({ where: { attemptId: at.id } });
    await ctx.db.quizAttempt.update({
      where: { id: at.id },
      data: {
        sumGrades: all.reduce((sum, x) => sum + Number(x.mark ?? 0), 0),
        needsManualGrading: all.some((x) => x.needsGrading),
      },
    });
    touched.add(at.userId);
  }
  for (const userId of touched) await updateQuizGrade(ctx, a, userId);
  if (!dryRun)
    await ctx.log('quiz.regraded', {
      activityId: a.id,
      attempts: report.attempts.length,
      changed: report.attempts.filter((x) => x.before !== x.after || x.maxBefore !== x.maxAfter)
        .length,
    });
  return report;
}

/** Can the learner see correct answers and feedback for this attempt now? */
export function reviewAllowed(s: QuizSettingsT, closeAt: Date | null, now: Date): boolean {
  if (s.reviewAnswers === 'never') return false;
  if (s.reviewAnswers === 'afterClose') return !!closeAt && now >= closeAt;
  return true;
}

// ── reading (the quiz page and the API queries share these) ─────────────────────

type Quiz = ActivityRef<QuizSettingsT>;

const scaled = (sum: unknown, max: number, gradeMax: number) =>
  sum === null || sum === undefined || !max ? null : (Number(sum) / max) * gradeMax;

/** The learner's view of the quiz: window, attempts, grade and what they may do next. */
export async function readQuizOverview(ctx: ModuleCtx, a: Quiz) {
  if (ctx.actor.kind !== 'user') throw new Error('Sign in required');
  const userId = ctx.actor.userId;
  const [e, attempts, questions, canAttempt, item] = await Promise.all([
    effectiveQuiz(ctx.db, a, userId),
    ctx.db.quizAttempt.findMany({
      where: { activityId: a.id, userId, preview: false },
      orderBy: { attemptNumber: 'asc' },
      include: { questions: { select: { maxMark: true } } },
    }),
    ctx.db.quizSlot.count({ where: { activityId: a.id } }),
    ctx.perm.can('mod.quiz:attempt', a.id),
    ctx.db.gradeItem.findFirst({ where: { activityId: a.id, itemNumber: 0 } }),
  ]);
  const grade = item
    ? await ctx.db.grade.findUnique({
        where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
      })
    : null;
  const open = quizIsOpen(e, ctx.now);
  const canReview = reviewAllowed(a.settings, e.closeAt, ctx.now);
  const rules = accessRules(a, e);
  const next = nextAttemptAt(
    rules,
    attempts.filter((x) => x.state === 'FINISHED').map((x) => x.finishedAt),
  );
  return {
    questions,
    requiresPassword: rules.passwords.length > 0,
    networkAllowed: networkAllowed(rules, ctx.ip),
    /** The wait between attempts ends then (null: no wait now). */
    nextAttemptAt: next && next > ctx.now ? next : null,
    timeLimitSec: e.timeLimitSec || null,
    /** null: unlimited */
    attemptsAllowed: e.attempts || null,
    attemptsLeft: e.attempts ? Math.max(0, e.attempts - attempts.length) : null,
    openAt: e.openAt,
    closeAt: e.closeAt,
    isOpen: open.ok,
    closedReason: open.ok ? null : open.reason,
    canAttempt,
    inProgressAttemptId: attempts.find((x) => x.state === 'IN_PROGRESS')?.id ?? null,
    gradeMax: a.settings.gradeMax,
    grade:
      grade?.finalGrade === null || grade?.finalGrade === undefined
        ? null
        : Number(grade.finalGrade),
    pendingGrade: attempts.some((x) => x.needsManualGrading),
    reviewAllowed: canReview,
    attempts: attempts.map((x) => ({
      id: x.id,
      attemptNumber: x.attemptNumber,
      state: x.state,
      startedAt: x.startedAt,
      finishedAt: x.finishedAt,
      needsManualGrading: x.needsManualGrading,
      grade:
        x.state === 'FINISHED'
          ? scaled(x.sumGrades, sumMaxMarks(x.questions), a.settings.gradeMax)
          : null,
      reviewable: x.state === 'FINISHED' && (canReview || a.settings.reviewMarks),
    })),
  };
}

/**
 * The user's own attempt in progress, as the player shows it: no fractions and no correct
 * answers. `null` when it is not theirs; `{ finished }` when it is no longer in progress.
 */
export async function readAttempt(ctx: ModuleCtx, a: Quiz, attemptId: string) {
  const at = await ctx.db.quizAttempt.findUnique({
    where: { id: attemptId },
    include: {
      questions: { orderBy: { slot: 'asc' }, include: { steps: { orderBy: { seq: 'asc' } } } },
    },
  });
  if (!at || at.activityId !== a.id || ctx.actor.kind !== 'user' || at.userId !== ctx.actor.userId)
    return null;
  const open = at.state === 'IN_PROGRESS';
  const sequential = a.settings.navMethod === 'sequential';
  const pages = [...new Set(at.questions.map((q) => q.page))].sort((x, y) => x - y);
  return {
    id: at.id,
    attemptNumber: at.attemptNumber,
    state: at.state,
    dueAt: at.dueAt,
    serverNow: new Date(),
    navMethod: a.settings.navMethod,
    behaviour: at.behaviour as Behaviour,
    currentPage: at.currentPage,
    pages: open ? pages : [],
    /** Every question's place and state, for the navigation panel (no content). */
    navigation: open
      ? at.questions.map((q) => {
          const type = (q.snapshot as unknown as QuestionSnapshot).type;
          return {
            slot: q.slot,
            page: q.page,
            graded: typeDef(type).grading !== 'none',
            answered: isAnswered(type, q.response),
            flagged: q.flagged,
          };
        })
      : [],
    // with sequential navigation only the current page: the others are not to be seen
    questions: open
      ? at.questions
          .filter((q) => !sequential || q.page === at.currentPage)
          .map((q) => ({
            ...toPublicQuestion(q),
            ...liveState(a.settings, at.behaviour as Behaviour, q, q.steps.map(asStep)),
          }))
      : [],
  };
}

/** A response as text for review screens (choices by their text, matches as pairs). */
export function answerText(snap: QuestionSnapshot, resp: unknown): string {
  return responseText(snap, resp);
}

export type ReviewVerdict = 'correct' | 'partial' | 'incorrect' | 'needsGrading';

export interface ReviewQuestion extends PublicQuestion {
  id: string;
  answerText: string;
  /** null unless marks may be shown */
  verdict: ReviewVerdict | null;
  mark: number | null;
  correctResponse: unknown;
  correctAnswerText: string | null;
  generalFeedback: string | null;
  /** Feedback for the answer given, when answers may be shown. */
  answerFeedback: string[];
  /** How each part scored (an ordering's items), when the question shows it. */
  partScores: { text: string; fraction: number | null }[] | null;
  comment: string | null;
  /** Teachers: what happened to the question, step by step. */
  history: ReviewStep[] | null;
}

export interface ReviewStep {
  seq: number;
  kind: Step['kind'];
  at: Date;
  answerText: string | null;
  /** The grade after this step, as a share of the mark. */
  fraction: number | null;
  state: 'TODO' | 'TRYAGAIN' | 'COMPLETE';
  userName: string | null;
}

/**
 * A finished attempt for review: its owner (once it is finished) or a teacher. Correct
 * answers and general feedback follow the quiz's review setting, marks its `reviewMarks`;
 * teachers and previews see everything. `null` when the user may not see it,
 * `'inProgress'` while the learner can still change answers.
 */
export async function readReview(ctx: ModuleCtx, a: Quiz, attemptId: string) {
  const at = await ctx.db.quizAttempt.findUnique({
    where: { id: attemptId },
    include: {
      questions: {
        orderBy: { slot: 'asc' },
        include: { steps: { orderBy: { seq: 'asc' } } },
      },
      user: { select: { name: true } },
    },
  });
  if (!at || at.activityId !== a.id) return null;
  const own = ctx.actor.kind === 'user' && at.userId === ctx.actor.userId;
  const teacher = await ctx.perm.can('mod.quiz:viewreports', a.id);
  if (!own && !teacher) return null;
  if (!teacher && !at.preview && at.state === 'IN_PROGRESS') return 'inProgress' as const;
  const e = await effectiveQuiz(ctx.db, a, at.userId);
  const showAnswers = teacher || at.preview || reviewAllowed(a.settings, e.closeAt, ctx.now);
  const showMarks = teacher || at.preview || a.settings.reviewMarks;
  const max = sumMaxMarks(at.questions);
  // who graded by hand, for the teacher's step history
  const graderIds = teacher
    ? [
        ...new Set(
          at.questions.flatMap((q) => q.steps.flatMap((s) => (s.userId ? [s.userId] : []))),
        ),
      ]
    : [];
  const graders = new Map(
    (
      await ctx.db.user.findMany({
        where: { id: { in: graderIds } },
        select: { id: true, name: true },
      })
    ).map((u) => [u.id, u.name]),
  );
  const questions: ReviewQuestion[] = at.questions.map((qa) => {
    const snap = qa.snapshot as unknown as QuestionSnapshot;
    const frac = qa.fraction === null ? null : Number(qa.fraction);
    const verdict: ReviewVerdict | null = qa.needsGrading
      ? 'needsGrading'
      : frac === null
        ? null
        : frac >= 0.9999
          ? 'correct'
          : frac > 0
            ? 'partial'
            : 'incorrect';
    const correct = showAnswers ? correctResponse(snap) : null;
    const steps = qa.steps.map(asStep);
    const behaviour = at.behaviour as Behaviour;
    return {
      ...toPublicQuestion(qa),
      id: qa.id,
      answerText: answerText(snap, qa.response),
      verdict: showMarks ? verdict : null,
      mark: showMarks && qa.mark !== null ? Number(qa.mark) : null,
      correctResponse: correct,
      correctAnswerText: correct ? answerText(snap, correct) : null,
      partScores: showAnswers && showMarks ? reviewParts(snap, qa.response) : null,
      generalFeedback: showAnswers ? fillText(snap, snap.generalFeedback ?? '') || null : null,
      answerFeedback: showAnswers ? feedbackHtml(replay(snap, steps, behaviour).feedback) : [],
      comment: qa.comment || null,
      history: teacher
        ? qa.steps.map((st, k) => {
            const o = replay(snap, steps.slice(0, k + 1), behaviour);
            return {
              seq: st.seq,
              kind: st.kind,
              at: st.createdAt,
              answerText:
                st.response === null || st.kind === 'MANUALGRADE'
                  ? null
                  : answerText(snap, st.response),
              fraction: o.fraction,
              state: o.state,
              userName: st.userId ? (graders.get(st.userId) ?? null) : null,
            };
          })
        : null,
    };
  });
  return {
    attempt: {
      id: at.id,
      attemptNumber: at.attemptNumber,
      state: at.state,
      preview: at.preview,
      userId: at.userId,
      userName: teacher ? at.user.name : null,
      startedAt: at.startedAt,
      finishedAt: at.finishedAt,
    },
    teacher,
    showAnswers,
    showMarks,
    gradeMax: a.settings.gradeMax,
    grade: showMarks ? scaled(at.sumGrades, max, a.settings.gradeMax) : null,
    pendingGrade: at.needsManualGrading,
    questions,
  };
}

const LiveStateOut = z.object({
  state: z.enum(['TODO', 'TRYAGAIN', 'COMPLETE']),
  canCheck: z.boolean().describe('the check action may be used now'),
  triesLeft: z.number().nullable().describe('interactive: tries left, this one included'),
  feedback: z
    .object({
      verdict: z.enum(['correct', 'partial', 'incorrect']),
      mark: z.number().nullable(),
      texts: z.array(z.string()).describe('feedback for the answer (sanitised HTML)'),
      hint: z.string().nullable().describe('sanitised HTML'),
      numCorrect: z.object({ right: z.number(), total: z.number() }).nullable(),
      rightAnswer: z.string().nullable(),
    })
    .nullable()
    .describe('after a check, as the quiz allows'),
});

const QuestionOut = z
  .object({
    slot: z.number(),
    page: z.number(),
    type: z.enum(questionTypes as [QuestionType, ...QuestionType[]]),
    text: z.string().describe('sanitised HTML'),
    maxMark: z.number(),
    response: z.unknown().describe('the saved answer, in the shape the save action takes'),
    flagged: z.boolean(),
  })
  .extend(PublicFields.shape);

export const quiz = defineModule<QuizSettingsT>({
  key: 'quiz',
  archetype: 'activity',
  icon: 'ListChecks',
  supports: { grading: true, groups: true, viewCompletion: true, backup: true },
  reset: {
    async userData(ctx, a) {
      await ctx.db.quizAttempt.deleteMany({ where: { activityId: a.id } });
      await ctx.db.quizOverride.deleteMany({ where: { activityId: a.id } });
    },
  },
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
  lifecycle: {
    // a new "questions per page" lays the questions out again, as Moodle's "repaginate now"
    async onUpdate(ctx, a, prev) {
      if (a.settings.perPage !== prev.perPage) await repaginate(ctx.db, a.id, a.settings.perPage);
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
  queries: {
    overview: defineQuery({
      summary: "The learner's quiz: window, attempts left, grade and their attempts",
      input: z.object({}),
      output: z.object({
        questions: z.number(),
        requiresPassword: z.boolean().describe('start takes the quiz password'),
        networkAllowed: z
          .boolean()
          .describe('false: the quiz only takes attempts from other network addresses'),
        nextAttemptAt: z
          .string()
          .nullable()
          .describe('the wait between attempts ends then; null: no wait now'),
        timeLimitSec: z.number().nullable(),
        attemptsAllowed: z.number().nullable().describe('null: unlimited'),
        attemptsLeft: z.number().nullable(),
        openAt: z.string().nullable(),
        closeAt: z.string().nullable(),
        isOpen: z.boolean(),
        closedReason: z.enum(['notOpen', 'closed']).nullable(),
        canAttempt: z.boolean(),
        inProgressAttemptId: z.string().uuid().nullable(),
        gradeMax: z.number(),
        grade: z.number().nullable(),
        pendingGrade: z.boolean(),
        reviewAllowed: z.boolean().describe('correct answers and feedback may be shown now'),
        attempts: z.array(
          z.object({
            id: z.string().uuid(),
            attemptNumber: z.number(),
            state: z.enum(['IN_PROGRESS', 'OVERDUE', 'FINISHED', 'ABANDONED']),
            startedAt: z.string(),
            finishedAt: z.string().nullable(),
            needsManualGrading: z.boolean(),
            grade: z.number().nullable(),
            reviewable: z.boolean(),
          }),
        ),
      }),
      handler: (ctx, a) => readQuizOverview(ctx, a as Quiz),
    }),
    attempt: defineQuery({
      summary: "Questions of the user's attempt in progress, without answers or fractions",
      capability: 'mod.quiz:attempt',
      input: z.object({ attemptId: z.string().uuid() }),
      output: z.object({
        id: z.string().uuid(),
        attemptNumber: z.number(),
        state: z.literal('IN_PROGRESS'),
        dueAt: z.string().nullable().describe('the attempt closes itself at this time'),
        serverNow: z.string(),
        navMethod: z
          .enum(['free', 'sequential'])
          .describe('sequential: pages in order with the page action, no going back'),
        currentPage: z.number(),
        pages: z.array(z.number()),
        navigation: z
          .array(
            z.object({
              slot: z.number(),
              page: z.number(),
              graded: z.boolean(),
              answered: z.boolean(),
              flagged: z.boolean(),
            }),
          )
          .describe('every question of the attempt, without its content'),
        behaviour: z
          .enum(behaviours)
          .describe('immediate and interactive: questions are checked one by one'),
        questions: z
          .array(QuestionOut.extend(LiveStateOut.shape))
          .describe('all questions, or only the current page with sequential navigation'),
      }),
      async handler(ctx, a, { attemptId }) {
        const r = await readAttempt(ctx, a as Quiz, attemptId);
        if (!r) throw new ModuleError('NOT_FOUND', 'Attempt not found');
        if (r.state !== 'IN_PROGRESS')
          throw new ModuleError('CONFLICT', 'The attempt is finished; read it with review');
        return r;
      },
    }),
    review: defineQuery({
      summary: 'A finished attempt with answers, marks and feedback as the quiz allows',
      input: z.object({ attemptId: z.string().uuid() }),
      output: z.object({
        attempt: z.object({
          id: z.string().uuid(),
          attemptNumber: z.number(),
          state: z.enum(['IN_PROGRESS', 'OVERDUE', 'FINISHED', 'ABANDONED']),
          preview: z.boolean(),
          userId: z.string().uuid(),
          userName: z.string().nullable().describe('for teachers'),
          startedAt: z.string(),
          finishedAt: z.string().nullable(),
        }),
        teacher: z.boolean(),
        showAnswers: z.boolean(),
        showMarks: z.boolean(),
        gradeMax: z.number(),
        grade: z.number().nullable(),
        pendingGrade: z.boolean(),
        questions: z.array(
          QuestionOut.extend({
            id: z.string().uuid(),
            answerText: z.string(),
            verdict: z.enum(['correct', 'partial', 'incorrect', 'needsGrading']).nullable(),
            mark: z.number().nullable(),
            correctResponse: z.unknown().describe('null unless answers may be shown'),
            correctAnswerText: z.string().nullable(),
            generalFeedback: z.string().nullable(),
            answerFeedback: z
              .array(z.string())
              .describe('feedback for the answer given (sanitised HTML), as the quiz allows'),
            partScores: z
              .array(z.object({ text: z.string(), fraction: z.number().nullable() }))
              .nullable()
              .describe("how each part scored (an ordering's items), when the question shows it"),
            comment: z.string().nullable().describe("the teacher's comment"),
            history: z
              .array(
                z.object({
                  seq: z.number(),
                  kind: z.enum(['SAVE', 'CHECK', 'TRYAGAIN', 'FINISH', 'MANUALGRADE']),
                  at: z.string(),
                  answerText: z.string().nullable(),
                  fraction: z.number().nullable(),
                  state: z.enum(['TODO', 'TRYAGAIN', 'COMPLETE']),
                  userName: z.string().nullable(),
                }),
              )
              .nullable()
              .describe('teachers: the steps of the question'),
          }),
        ),
      }),
      async handler(ctx, a, { attemptId }) {
        const r = await readReview(ctx, a as Quiz, attemptId);
        if (!r) throw new ModuleError('NOT_FOUND', 'Attempt not found');
        if (r === 'inProgress')
          throw new ModuleError('CONFLICT', 'The attempt is in progress; finish it first');
        return r;
      },
    }),
  },
  actions: {
    // ── editing ──
    addQuestions: defineAction({
      summary: 'Add questions from the course question bank as fixed slots',
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
        const pages = await slotPages(ctx.db, a.id);
        const perPage = (a as ActivityRef<QuizSettingsT>).settings.perPage;
        const qs = await ctx.db.question.findMany({
          where: { id: { in: questionIds }, category: { contextId: a.courseId } },
        });
        for (const id of questionIds) {
          const q = qs.find((x) => x.id === id);
          if (!q) continue;
          const page = pageForNewSlot(pages, perPage);
          pages.push(page);
          await ctx.db.quizSlot.create({
            data: {
              activityId: a.id,
              slot: ++n,
              page,
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
      summary: 'Add slots that draw random questions from a category',
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
        const pages = await slotPages(ctx.db, a.id);
        const perPage = (a as ActivityRef<QuizSettingsT>).settings.perPage;
        for (let i = 0; i < input.count; i++) {
          const page = pageForNewSlot(pages, perPage);
          pages.push(page);
          await ctx.db.quizSlot.create({
            data: {
              activityId: a.id,
              slot: ++n,
              page,
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
      summary: 'Remove or move a slot, change its mark, or add or remove the page break after it',
      capability: 'course:manageactivities',
      input: z.object({
        slot: z.number().int().min(1),
        op: z.enum(['remove', 'up', 'down', 'mark', 'pageBreak']),
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
        // Pages only shape attempts started later, so they may change at any time.
        if (input.op === 'pageBreak') {
          const next = slots[i + 1];
          if (!next) return { ok: true };
          const shift = next.page === slots[i]!.page ? 1 : -1;
          const pages = normalisePages(slots.map((s, k) => (k > i ? s.page + shift : s.page)));
          for (const [k, s] of slots.entries())
            if (s.page !== pages[k])
              await ctx.db.quizSlot.update({ where: { id: s.id }, data: { page: pages[k]! } });
          return { ok: true };
        }
        if (hasAttempts) throw new Error('Cannot change questions after attempts exist');
        // Questions move between positions; each position keeps its page.
        const pageAt = slots.map((s) => s.page);
        if (input.op === 'remove') pageAt.splice(i, 1);
        let order = [...slots];
        if (input.op === 'remove') order.splice(i, 1);
        if (input.op === 'up' && i > 0) [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
        if (input.op === 'down' && i < order.length - 1)
          [order[i + 1], order[i]] = [order[i]!, order[i + 1]!];
        if (input.op === 'remove') await ctx.db.quizSlot.delete({ where: { id: slots[i]!.id } });
        order = order.filter((s) => input.op !== 'remove' || s.id !== slots[i]!.id);
        // Two passes to avoid unique (activityId, slot) collisions.
        const pages = normalisePages(pageAt);
        for (const [k, s] of order.entries())
          await ctx.db.quizSlot.update({ where: { id: s.id }, data: { slot: 10_000 + k } });
        for (const [k, s] of order.entries())
          await ctx.db.quizSlot.update({
            where: { id: s.id },
            data: { slot: k + 1, page: pages[k] ?? 1 },
          });
        return { ok: true };
      },
    }),
    repaginate: defineAction({
      summary: 'Lay the questions out anew, a given number to a page (0: all on one page)',
      capability: 'course:manageactivities',
      input: z.object({ perPage: z.number().int().min(0).max(100) }),
      async handler(ctx, a, { perPage }) {
        await repaginate(ctx.db, a.id, perPage);
        return { ok: true };
      },
    }),
    // ── attempts ──
    start: defineAction({
      summary:
        'Start an attempt or resume the open one; `preview` for teachers. `password` when the quiz has one',
      input: z.object({
        preview: z.boolean().default(false),
        password: z.string().max(255).optional(),
      }),
      async handler(ctx, a, { preview, password }) {
        const userId = uid(ctx);
        const quizA = a as ActivityRef<QuizSettingsT>;
        if (preview) await ctx.perm.require('mod.quiz:preview', a.id);
        else await ctx.perm.require('mod.quiz:attempt', a.id);
        requireNetwork(ctx, quizA);
        const open = await ctx.db.quizAttempt.findFirst({
          where: { activityId: a.id, userId, preview, state: 'IN_PROGRESS' },
        });
        if (open) return { attemptId: open.id };
        const e = await effectiveQuiz(ctx.db, quizA, userId);
        const finished = await ctx.db.quizAttempt.findMany({
          where: { activityId: a.id, userId, preview: false, state: 'FINISHED' },
          orderBy: { attemptNumber: 'asc' },
          select: { finishedAt: true },
        });
        const refusal = checkStart(accessRules(quizA, e), {
          ip: ctx.ip,
          now: ctx.now,
          finished: finished.map((x) => x.finishedAt),
          password,
          preview,
        });
        if (refusal?.reason === 'password')
          throw new ModuleError('FORBIDDEN', 'The quiz password is wrong');
        if (refusal?.reason === 'delay')
          throw new ModuleError(
            'CONFLICT',
            `The next attempt can start at ${refusal.until.toISOString()}`,
          );
        if (!preview) {
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
      summary: 'Save answers and flags of your attempt without finishing it',
      input: z.object({
        attemptId: z.string().uuid(),
        answers: z.record(z.string(), z.unknown()).default({}),
        flags: z.record(z.string(), z.boolean()).optional(),
      }),
      async handler(ctx, a, input) {
        const quizA = a as ActivityRef<QuizSettingsT>;
        const at = await ownAttempt(ctx, a, input.attemptId);
        if (at.state !== 'IN_PROGRESS') throw new Error('This attempt is closed');
        requireNetwork(ctx, quizA);
        if (at.dueAt && ctx.now.getTime() > at.dueAt.getTime() + GRACE_MS) {
          // Returned, not thrown: an error would roll the submission back with the transaction.
          await finishAttempt(ctx, quizA, at.id);
          return { savedAt: null, closed: true };
        }
        await saveResponses(ctx, at.id, input.answers, input.flags, currentPageOnly(quizA, at));
        return { savedAt: ctx.now.toISOString(), closed: false };
      },
    }),
    page: defineAction({
      summary:
        'Save the answers of this page and go to another page of your attempt (with sequential navigation only to the next one)',
      input: z.object({
        attemptId: z.string().uuid(),
        answers: z.record(z.string(), z.unknown()).default({}),
        flags: z.record(z.string(), z.boolean()).optional(),
        to: z.number().int().min(1),
      }),
      async handler(ctx, a, input) {
        const quizA = a as ActivityRef<QuizSettingsT>;
        const at = await ownAttempt(ctx, a, input.attemptId);
        if (at.state !== 'IN_PROGRESS') throw new Error('This attempt is closed');
        requireNetwork(ctx, quizA);
        if (at.dueAt && ctx.now.getTime() > at.dueAt.getTime() + GRACE_MS) {
          await finishAttempt(ctx, quizA, at.id);
          return { currentPage: at.currentPage, closed: true };
        }
        const rows = await ctx.db.questionAttempt.findMany({
          where: { attemptId: at.id },
          select: { page: true },
        });
        const pages = [...new Set(rows.map((r) => r.page))].sort((x, y) => x - y);
        if (!pages.includes(input.to)) throw new ModuleError('NOT_FOUND', 'No such page');
        const next = pages.find((p) => p > at.currentPage);
        if (
          quizA.settings.navMethod === 'sequential' &&
          input.to !== at.currentPage &&
          input.to !== next
        )
          throw new ModuleError('CONFLICT', 'This quiz goes page by page: you cannot go back');
        await saveResponses(ctx, at.id, input.answers, input.flags, currentPageOnly(quizA, at));
        await ctx.db.quizAttempt.update({ where: { id: at.id }, data: { currentPage: input.to } });
        return { currentPage: input.to, closed: false };
      },
    }),
    check: defineAction({
      summary:
        'Immediate and interactive behaviours: save one answer and check it now. Returns the question with its feedback',
      input: z.object({
        attemptId: z.string().uuid(),
        slot: z.number().int().min(1),
        response: z.unknown(),
      }),
      async handler(ctx, a, input) {
        const { quizA, at, qa, snap, behaviour, closed } = await questionInPlay(
          ctx,
          a,
          input.attemptId,
          input.slot,
        );
        if (closed) return { closed: true, question: null };
        if (behaviour === 'deferred' || typeDef(snap.type).grading !== 'auto')
          throw new ModuleError('CONFLICT', 'This question is graded when the attempt is finished');
        if (qa.state !== 'TODO')
          throw new ModuleError('CONFLICT', 'This answer is checked already');
        const resp = cleanResponse(snap.type, input.response);
        if (!resp || !isAnswered(snap.type, resp))
          throw new Error('Answer the question before checking it');
        await addStep(ctx.db, qa.id, { kind: 'CHECK', response: resp });
        await settle(ctx.db, qa, behaviour);
        return { closed: false, question: await liveQuestion(ctx.db, quizA, at, qa.id) };
      },
    }),
    tryAgain: defineAction({
      summary:
        'Interactive behaviour: after a wrong answer, open the question for the next try (wrong parts cleared if its hint says so)',
      input: z.object({ attemptId: z.string().uuid(), slot: z.number().int().min(1) }),
      async handler(ctx, a, input) {
        const { quizA, at, qa, snap, behaviour, closed } = await questionInPlay(
          ctx,
          a,
          input.attemptId,
          input.slot,
        );
        if (closed) return { closed: true, question: null };
        if (qa.state !== 'TRYAGAIN') throw new ModuleError('CONFLICT', 'There is nothing to retry');
        const o = replay(snap, await stepsOf(ctx.db, qa.id), behaviour);
        const next = o.hint?.clearWrong ? clearWrongParts(snap, o.response) : o.response;
        await addStep(ctx.db, qa.id, { kind: 'TRYAGAIN', response: next });
        await settle(ctx.db, qa, behaviour);
        return { closed: false, question: await liveQuestion(ctx.db, quizA, at, qa.id) };
      },
    }),
    finish: defineAction({
      summary: 'Save the last answers and finish your attempt',
      input: z.object({
        attemptId: z.string().uuid(),
        answers: z.record(z.string(), z.unknown()).default({}),
      }),
      async handler(ctx, a, input) {
        const quizA = a as ActivityRef<QuizSettingsT>;
        const at = await ownAttempt(ctx, a, input.attemptId);
        if (at.state !== 'IN_PROGRESS') return { attemptId: at.id };
        requireNetwork(ctx, quizA);
        const late = at.dueAt && ctx.now.getTime() > at.dueAt.getTime() + GRACE_MS;
        if (!late)
          await saveResponses(ctx, at.id, input.answers, undefined, currentPageOnly(quizA, at));
        await finishAttempt(ctx, quizA, at.id);
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
    setOverride: defineAction({
      summary: 'Give one participant or a group their own dates, time limit, attempts or password',
      capability: 'mod.quiz:manageoverrides',
      input: z
        .object({
          userId: z.string().uuid().optional(),
          groupId: z.string().uuid().optional(),
          openAt: z.string().datetime({ offset: true }).nullable().default(null),
          closeAt: z.string().datetime({ offset: true }).nullable().default(null),
          timeLimitMin: z
            .number()
            .int()
            .min(0)
            .max(24 * 60)
            .nullable()
            .default(null),
          attempts: z.number().int().min(0).max(100).nullable().default(null),
          /** Their own password; '' lifts the quiz's, null keeps it. */
          password: z.string().max(255).nullable().default(null),
        })
        .refine((v) => !!v.userId !== !!v.groupId, 'Choose a participant or a group')
        .refine(
          (v) =>
            v.openAt ||
            v.closeAt ||
            v.timeLimitMin !== null ||
            v.attempts !== null ||
            v.password !== null,
          'Change at least one setting',
        )
        .refine(
          (v) => !v.openAt || !v.closeAt || new Date(v.closeAt) > new Date(v.openAt),
          'Close date must be after open date',
        ),
      async handler(ctx, a, input) {
        if (input.userId) {
          const enrolled = await ctx.db.enrolment.findFirst({
            where: { courseId: a.courseId, userId: input.userId },
          });
          if (!enrolled) throw new Error('User is not enrolled');
        } else {
          const g = await ctx.db.group.findFirst({
            where: { id: input.groupId, courseId: a.courseId },
          });
          if (!g) throw new Error('Unknown group');
        }
        const data = {
          openAt: input.openAt ? new Date(input.openAt) : null,
          closeAt: input.closeAt ? new Date(input.closeAt) : null,
          timeLimitSec: input.timeLimitMin === null ? null : input.timeLimitMin * 60,
          attempts: input.attempts,
          password: input.password,
        };
        const o = input.userId
          ? await ctx.db.quizOverride.upsert({
              where: { activityId_userId: { activityId: a.id, userId: input.userId } },
              create: { activityId: a.id, userId: input.userId, ...data },
              update: data,
            })
          : await ctx.db.quizOverride.upsert({
              where: { activityId_groupId: { activityId: a.id, groupId: input.groupId! } },
              create: { activityId: a.id, groupId: input.groupId!, ...data },
              update: data,
            });
        await ctx.log('quiz.override.saved', {
          activityId: a.id,
          userId: input.userId ?? null,
          groupId: input.groupId ?? null,
        });
        return { id: o.id };
      },
    }),
    deleteOverride: defineAction({
      summary: 'Remove a participant or group setting',
      capability: 'mod.quiz:manageoverrides',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, { id }) {
        await ctx.db.quizOverride.deleteMany({ where: { id, activityId: a.id } });
        return { ok: true };
      },
    }),
    regrade: defineAction({
      summary:
        'Regrade finished attempts with the current questions; `dryRun` only reports changes',
      capability: 'mod.quiz:grade',
      input: z.object({ dryRun: z.boolean().default(true) }),
      async handler(ctx, a, { dryRun }) {
        return regradeQuiz(ctx, a as ActivityRef<QuizSettingsT>, dryRun);
      },
    }),
    gradeQuestion: defineAction({
      summary: 'Mark a manually graded answer (essay) and comment on it',
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
        const graderId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
        await ctx.db.questionAttempt.update({
          where: { id: qa.id },
          data: { comment: sanitizeRichText(input.comment), gradedById: graderId },
        });
        await addStep(ctx.db, qa.id, {
          kind: 'MANUALGRADE',
          fraction: max ? input.mark / max : 0,
          userId: graderId,
        });
        await settle(ctx.db, qa, qa.attempt.behaviour as Behaviour);
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
      // the learner's own dates (overrides) decide what is still to do
      const { closeAt } = await effectiveQuiz(
        ctx.db,
        { ...(a as never as ActivityRef<QuizSettingsT>), settings: s.data },
        userId,
      );
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
