import { opRandom, type Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import {
  type ActivityRef,
  defineAction,
  defineModule,
  defineQuery,
  type ModuleCtx,
  ModuleError,
  msg,
} from '@hubium/module-sdk';
import { bool, isoDate, optionalNumber } from '@hubium/module-sdk/fields';
import { z } from 'zod';
import {
  type Answer,
  attemptGrade,
  checkResponse,
  defaultStructureJump,
  END,
  type Grade,
  isQuestion,
  isStructure,
  jumpKeywords,
  landOn,
  lessonPercent,
  type Page,
  type PageType,
  pageTypes,
  type Response,
  resolveJump,
  type Step,
} from './engine.ts';

// mod-lesson: pages of content and questions joined by jumps, as Moodle's lesson. A
// content page ends with buttons that lead on; a question's answers lead on too, right
// or wrong, so a learner's way through depends on their answers. Branches, clusters and
// random questions come from the jumps (see engine.ts). Each go is an attempt; its steps
// make the grade, as in Moodle, and essays wait for a teacher.

export const LessonSettings = z
  .object({
    /** A practice lesson has no grade. */
    practice: bool(false),
    gradeMax: z.coerce.number().min(0).max(1000).default(100),
    gradePass: optionalNumber(0, 1000),
    /** Answers carry their own points; otherwise a correct answer is one point. */
    customScoring: bool(true),
    /** Learners may take the lesson again. */
    retake: bool(false),
    /** With retakes, the best attempt counts (otherwise their mean). */
    useMaxGrade: bool(false),
    /** Tries at a question before moving on. */
    maxAttempts: z.coerce.number().int().min(1).max(10).default(1),
    /** Fewer questions answered count as wrong ones. */
    minQuestions: z.coerce.number().int().min(0).max(100).default(0),
    /** After a wrong answer, offer to try the question again. */
    review: bool(false),
    /** Say "correct"/"wrong" after every answer, even without a response. */
    feedback: bool(false),
    /** Show the score so far. */
    ongoing: bool(false),
    progressBar: bool(false),
    /** A menu of content pages beside the lesson. */
    displayMenu: bool(false),
    timeLimitMin: optionalNumber(1, 1440),
    opensAt: isoDate,
    closesAt: isoDate,
    password: z.string().max(255).default(''),
  })
  .refine((s) => !s.opensAt || !s.closesAt || s.closesAt > s.opensAt, {
    message: 'mod.lesson.errors.closeAfterOpen',
    path: ['closesAt'],
  })
  .refine((s) => s.gradePass === undefined || s.gradePass <= s.gradeMax, {
    message: 'errors.common.passGradeAboveMax',
    path: ['gradePass'],
  });
export type LessonSettingsT = z.output<typeof LessonSettings>;
type Lesson = ActivityRef<LessonSettingsT>;

const uid = (ctx: ModuleCtx) => {
  if (ctx.actor.kind !== 'user') throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
  return ctx.actor.userId;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** As the quiz takes short answers: checking them is cheap, an essay alone is long. */
const SHORT_ANSWER_MAX = 1000;

// ── pages ──

export interface LessonPageT extends Page {
  title: string;
  contents: string;
  options: Page['options'] & { horizontal?: boolean; inMenu?: boolean };
}

const AnswerRow = z.object({
  id: z.string().max(64).optional(),
  text: z.string().trim().max(2000).default(''),
  response: z.string().trim().max(5000).default(''),
  jump: z.string().max(64).default('next'),
  score: z.coerce.number().min(-1000).max(1000).default(0),
});

const PageOptions = z.object({
  multiple: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  horizontal: z.boolean().optional(),
  inMenu: z.boolean().optional(),
  pairs: z
    .array(z.object({ left: z.string().trim().max(2000), right: z.string().trim().max(2000) }))
    .max(50)
    .optional(),
});

export const PageInput = z.object({
  title: z.string().trim().max(255).default(''),
  contents: z.string().max(200_000).default(''),
  answers: z.array(AnswerRow).max(50).default([]),
  options: PageOptions.default({}),
});
type PageInputT = z.output<typeof PageInput>;

/** How many answers each kind of page takes. */
function checkPage(type: PageType, p: PageInputT): string | null {
  const n = p.answers.length;
  if (!isStructure(type) && !p.title) return 'A page needs a title';
  if (type === 'content' && n < 1) return 'A content page needs a button';
  if (type === 'truefalse' && n !== 2) return 'True/false takes two answers';
  if (type === 'multichoice' && n < 2) return 'A choice needs two answers or more';
  if ((type === 'shortanswer' || type === 'numerical') && n < 1) return 'Give an answer';
  if (type === 'matching' && (n !== 2 || (p.options.pairs?.length ?? 0) < 2))
    return 'Matching takes two pairs or more';
  if ((type === 'essay' || isStructure(type)) && n !== 1) return 'This page has one jump';
  if (['content', 'multichoice', 'truefalse', 'shortanswer', 'numerical'].includes(type))
    if (p.answers.some((a) => !a.text)) return 'Every answer needs a text';
  return null;
}

/** Answers as stored: ids kept or given, jumps only to keywords or pages of the lesson. */
function answerRows(rows: PageInputT['answers'], pageIds: Set<string>): Answer[] {
  return rows.map((r) => ({
    id: r.id && UUID.test(r.id) ? r.id : opRandom().uuid(),
    text: r.text,
    response: r.response,
    jump:
      (jumpKeywords as readonly string[]).includes(r.jump) || pageIds.has(r.jump) ? r.jump : 'next',
    score: r.score,
  }));
}

const pageFromRow = (r: {
  id: string;
  type: string;
  title: string;
  contents: string;
  answers: Prisma.JsonValue;
  options: Prisma.JsonValue;
}): LessonPageT => ({
  id: r.id,
  type: r.type as PageType,
  title: r.title,
  contents: r.contents,
  answers: (Array.isArray(r.answers) ? r.answers : []) as unknown as Answer[],
  options: (r.options && typeof r.options === 'object' ? r.options : {}) as LessonPageT['options'],
});

export async function lessonPages(db: Prisma.TransactionClient, activityId: string) {
  const rows = await db.lessonPage.findMany({
    where: { activityId },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map(pageFromRow);
}

async function pageOf(ctx: ModuleCtx, a: ActivityRef, id: string) {
  const row = await ctx.db.lessonPage.findFirst({ where: { id, activityId: a.id } });
  if (!row) throw new ModuleError('NOT_FOUND', msg('mod.lesson.errors.noPage'));
  return row;
}

/** Sets sortOrder to 0..n-1 in the given order. */
async function renumber(db: Prisma.TransactionClient, ids: string[]) {
  for (const [i, id] of ids.entries())
    await db.lessonPage.update({ where: { id }, data: { sortOrder: i } });
}

// ── attempts ──

type AttemptRow = Prisma.LessonAttemptGetPayload<object>;

const pick = <T>(items: T[]): T => items[opRandom().int(0, items.length)]!;

async function stepsOf(db: Prisma.TransactionClient, attemptId: string) {
  return db.lessonStep.findMany({ where: { attemptId }, orderBy: { seq: 'asc' } });
}

/**
 * Records a step after the attempt's others (a second, simultaneous one fails). After the
 * last one, not at the count: a deleted page takes its steps along.
 */
async function addStep(
  ctx: ModuleCtx,
  attemptId: string,
  data: Omit<Prisma.LessonStepUncheckedCreateInput, 'attemptId' | 'seq'>,
) {
  const last = await ctx.db.lessonStep.aggregate({ where: { attemptId }, _max: { seq: true } });
  const seq = (last._max.seq ?? -1) + 1;
  return ctx.db.lessonStep.create({ data: { ...data, attemptId, seq, createdAt: ctx.now } });
}

/** Every finished attempt's result worked out again, and the grades that follow. */
async function regradeFinished(ctx: ModuleCtx, a: Lesson) {
  const pages = await lessonPages(ctx.db, a.id);
  const done = await ctx.db.lessonAttempt.findMany({
    where: { activityId: a.id, finishedAt: { not: null } },
    include: { steps: { orderBy: { seq: 'asc' } } },
  });
  for (const at of done)
    await ctx.db.lessonAttempt.update({
      where: { id: at.id },
      data: { percent: gradeOf(a.settings, pages, at.steps).percent },
    });
  for (const userId of new Set(done.filter((x) => !x.preview).map((x) => x.userId)))
    await pushGrade(ctx, a, userId);
}

const engineSteps = (rows: { pageId: string; kind: string; correct: boolean }[]): Step[] =>
  rows.map((r) => ({ pageId: r.pageId, kind: r.kind as Step['kind'], correct: r.correct }));

export function gradeOf(
  s: LessonSettingsT,
  pages: Page[],
  rows: {
    pageId: string;
    kind: string;
    correct: boolean;
    score: number;
    essayScore: number | null;
  }[],
): Grade {
  return attemptGrade(
    pages,
    rows.filter((r) => r.kind === 'answer'),
    { custom: s.customScoring, maxAttempts: s.maxAttempts, minQuestions: s.minQuestions },
  );
}

const graded = (s: LessonSettingsT) => !s.practice && s.gradeMax > 0;

/** The learner's grade in the gradebook: their finished attempts, best or mean. */
async function pushGrade(ctx: ModuleCtx, a: Lesson, userId: string) {
  if (!graded(a.settings)) return;
  const done = await ctx.db.lessonAttempt.findMany({
    where: { activityId: a.id, userId, preview: false, finishedAt: { not: null } },
    select: { percent: true },
  });
  const p = lessonPercent(
    done.map((x) => x.percent),
    a.settings.useMaxGrade,
  );
  await ctx.grades.setGrades(a.id, [
    {
      userId,
      itemNumber: 0,
      rawGrade: p === null ? null : Math.round((p / 100) * a.settings.gradeMax * 100_000) / 100_000,
    },
  ]);
}

/** Ends an attempt: its grade from its steps, then the learner's grade and completion. */
export async function finishAttempt(ctx: ModuleCtx, a: Lesson, at: AttemptRow) {
  const [pages, rows] = await Promise.all([lessonPages(ctx.db, a.id), stepsOf(ctx.db, at.id)]);
  const g = gradeOf(a.settings, pages, rows);
  const due = at.dueAt && at.dueAt < ctx.now ? at.dueAt : null;
  await ctx.db.lessonAttempt.update({
    where: { id: at.id },
    data: { finishedAt: due ?? ctx.now, currentPageId: null, percent: g.percent },
  });
  if (at.preview) return g;
  await pushGrade(ctx, a, at.userId);
  await ctx.completion.recompute(a.id, at.userId);
  await ctx.log('lesson.attempt.finished', { activityId: a.id, attemptId: at.id });
  return g;
}

/** Moves the attempt to a page (passing structural pages), or ends it. */
async function moveTo(ctx: ModuleCtx, a: Lesson, at: AttemptRow, target: string) {
  const [pages, rows] = await Promise.all([lessonPages(ctx.db, a.id), stepsOf(ctx.db, at.id)]);
  const landed = target === END ? END : landOn(pages, target, engineSteps(rows), pick);
  if (landed === END) {
    await finishAttempt(ctx, a, at);
    return END;
  }
  await ctx.db.lessonAttempt.update({ where: { id: at.id }, data: { currentPageId: landed } });
  await addStep(ctx, at.id, { pageId: landed, kind: 'view' });
  return landed;
}

/**
 * When an attempt ends by itself: its time limit, or the lesson's close date if sooner (a
 * teacher's try goes on after it).
 */
function attemptEnds(a: Lesson, at: Pick<AttemptRow, 'dueAt' | 'preview'>): Date | null {
  const closes = !at.preview && a.settings.closesAt ? new Date(a.settings.closesAt) : null;
  if (!at.dueAt) return closes;
  return closes && closes < at.dueAt ? closes : at.dueAt;
}

/**
 * The user's open attempt. One whose time ran out or whose lesson has closed is over:
 * actions end it first (`end`); a read only treats it as over and leaves the ending to
 * the action or the overdue sweep, as reads write nothing.
 */
export async function openAttempt(
  ctx: ModuleCtx,
  a: Lesson,
  userId: string,
  opts: { end: boolean } = { end: true },
): Promise<AttemptRow | null> {
  const at = await ctx.db.lessonAttempt.findFirst({
    where: { activityId: a.id, userId, finishedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  const ends = at && attemptEnds(a, at);
  if (at && ends && ends < ctx.now) {
    if (opts.end) await finishAttempt(ctx, a, { ...at, dueAt: ends });
    return null;
  }
  return at;
}

/** Open attempts take a new time limit or close date at once (the sweep ends them then). */
async function refreshOpenAttempts(ctx: ModuleCtx, a: Lesson) {
  const open = await ctx.db.lessonAttempt.findMany({
    where: { activityId: a.id, finishedAt: null },
    select: { id: true, startedAt: true, dueAt: true, preview: true },
  });
  const limit = (a.settings.timeLimitMin ?? 0) * 60_000;
  for (const at of open) {
    const dueAt = attemptEnds(a, {
      dueAt: limit ? new Date(at.startedAt.getTime() + limit) : null,
      preview: at.preview,
    });
    if (dueAt?.getTime() !== at.dueAt?.getTime())
      await ctx.db.lessonAttempt.update({ where: { id: at.id }, data: { dueAt } });
  }
}

async function requireOpen(ctx: ModuleCtx, a: Lesson) {
  const at = await openAttempt(ctx, a, uid(ctx));
  if (!at) throw new ModuleError('CONFLICT', msg('mod.lesson.errors.attemptOver'));
  return at;
}

/** Can the learner start (or retake) the lesson now, and if not, why? */
export function lessonWindow(s: LessonSettingsT, now: Date) {
  if (s.opensAt && now < new Date(s.opensAt)) return 'notOpen' as const;
  if (s.closesAt && now > new Date(s.closesAt)) return 'closed' as const;
  return null;
}

/** A page as the learner sees it: without what is right, with matches shuffled. */
export function playerPage(p: LessonPageT, seed: string) {
  const base = { id: p.id, type: p.type, title: p.title, contents: p.contents };
  if (p.type === 'content')
    return {
      ...base,
      buttons: p.answers.map((x) => ({ id: x.id, text: x.text })),
      horizontal: !!p.options.horizontal,
    };
  if (p.type === 'multichoice' || p.type === 'truefalse')
    return {
      ...base,
      choices: p.answers.map((x) => ({ id: x.id, text: x.text })),
      multiple: p.type === 'multichoice' && !!p.options.multiple,
    };
  if (p.type === 'matching') {
    const rights = [...new Set((p.options.pairs ?? []).map((x) => x.right))];
    // the same order for the attempt: sorted by a hash of the attempt and the text
    const h = (t: string) => [...`${seed}${t}`].reduce((s, c) => (s * 31 + c.charCodeAt(0)) | 0, 7);
    return {
      ...base,
      lefts: (p.options.pairs ?? []).map((x) => x.left),
      rights: rights.sort((x, y) => h(x) - h(y)),
    };
  }
  return base;
}
export type PlayerPage = ReturnType<typeof playerPage>;

/** What the learner sees of the lesson: the open attempt and its page, or past attempts. */
export async function lessonState(ctx: ModuleCtx, ref: ActivityRef, userId: string) {
  const a = ref as Lesson;
  const s = a.settings;
  const at = await openAttempt(ctx, a, userId, { end: false });
  const [pages, finished] = await Promise.all([
    lessonPages(ctx.db, a.id),
    ctx.db.lessonAttempt.findMany({
      where: { activityId: a.id, userId, finishedAt: { not: null } },
      orderBy: { number: 'asc' },
      include: { steps: { orderBy: { seq: 'asc' } } },
    }),
  ]);
  const essayMax = (pageId: string) => {
    const p = pages.find((x) => x.id === pageId);
    return s.customScoring ? Math.max(0, ...(p?.answers ?? []).map((x) => x.score)) : 1;
  };
  const past = finished.map((x) => {
    const g = gradeOf(s, pages, x.steps);
    return {
      id: x.id,
      number: x.number,
      preview: x.preview,
      startedAt: x.startedAt,
      finishedAt: x.finishedAt!,
      percent: x.percent,
      earned: g.earned,
      total: g.total,
      pending: g.pending,
      /** The teacher's points and comment on each essay graded. */
      essays: x.steps
        .filter((r) => r.kind === 'answer' && r.gradedAt && r.essayScore !== null)
        .map((r) => ({
          title: pages.find((p) => p.id === r.pageId)?.title ?? '',
          score: r.essayScore!,
          max: essayMax(r.pageId),
          comment: r.essayComment,
        })),
    };
  });
  const realPast = past.filter((x) => !x.preview);
  const lessonGrade = lessonPercent(
    realPast.map((x) => x.percent),
    s.useMaxGrade,
  );
  let current = null;
  if (at?.currentPageId) {
    const rows = await stepsOf(ctx.db, at.id);
    const page = pages.find((p) => p.id === at.currentPageId);
    if (page) {
      const g = gradeOf(s, pages, rows);
      const shown = pages.filter((p) => !isStructure(p.type));
      const visited = new Set(rows.map((r) => r.pageId));
      const tries = rows.filter((r) => r.kind === 'answer' && r.pageId === page.id);
      const last = tries[tries.length - 1];
      current = {
        attemptId: at.id,
        preview: at.preview,
        dueAt: at.dueAt,
        page: playerPage(page, at.id),
        /** A wrong answer that may be tried again or left. */
        retry:
          !!last &&
          !last.correct &&
          isQuestion(page.type) &&
          page.type !== 'essay' &&
          tries.length < s.maxAttempts &&
          rows[rows.length - 1]?.id === last.id,
        progress: shown.length
          ? Math.round((shown.filter((p) => visited.has(p.id)).length / shown.length) * 100)
          : 0,
        score: s.ongoing ? { earned: g.earned, total: g.total } : null,
        menu: s.displayMenu
          ? pages
              .filter((p) => p.type === 'content' && p.options.inMenu !== false)
              .map((p) => ({ id: p.id, title: p.title }))
          : [],
      };
    }
  }
  return {
    current,
    past,
    lessonPercent: lessonGrade,
    hasPages: pages.some((p) => !isStructure(p.type)),
    window: lessonWindow(s, ctx.now),
    canRetake: s.retake || !realPast.length,
  };
}

// ── backup ──

const ExportedPage = z.object({
  key: z.string().max(64),
  type: z.enum(pageTypes),
  title: z.string().max(255),
  contents: z.string().max(200_000),
  answers: z.array(AnswerRow).max(50),
  options: PageOptions,
});

/** Rewrites ids an import mapped (files in contents). */
function rewriteIds(text: string, map: (old: string) => string | undefined) {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (m) => map(m.toLowerCase()) ?? m,
  );
}

/**
 * Creates pages from a backup's (or another lesson's) list in order: jumps to pages of the
 * list point to the new pages.
 */
export async function importPages(
  db: Prisma.TransactionClient,
  activityId: string,
  list: z.input<typeof ExportedPage>[],
  map: (old: string) => string | undefined = () => undefined,
) {
  const ids = new Map(list.map((p) => [p.key, opRandom().uuid()]));
  const known = new Set(ids.values());
  for (const [i, raw] of list.entries()) {
    const p = ExportedPage.safeParse(raw);
    if (!p.success) continue;
    const answers = answerRows(
      PageInput.parse({ answers: p.data.answers }).answers.map((x) => ({
        ...x,
        jump: ids.get(x.jump) ?? x.jump,
      })),
      known,
    );
    await db.lessonPage.create({
      data: {
        id: ids.get(p.data.key)!,
        activityId,
        sortOrder: i,
        type: p.data.type,
        title: p.data.title,
        contents: sanitizeRichText(rewriteIds(p.data.contents, map)),
        answers: answers as unknown as Prisma.InputJsonValue,
        options: p.data.options as Prisma.InputJsonValue,
      },
    });
  }
}

// ── the module ──

export const lesson = defineModule<LessonSettingsT>({
  key: 'lesson',
  archetype: 'activity',
  icon: 'Signpost',
  supports: { viewCompletion: true },
  settings: {
    schema: LessonSettings as unknown as z.ZodType<LessonSettingsT>,
    defaults: () => LessonSettings.parse({}),
  },
  grading: {
    items: (a) =>
      graded(a.settings)
        ? [
            {
              itemNumber: 0,
              name: '',
              gradeMax: a.settings.gradeMax,
              gradePass: a.settings.gradePass,
            },
          ]
        : [],
  },
  calendar: {
    events: (a) => [
      ...(a.settings.opensAt
        ? [{ kind: 'OPEN' as const, title: a.name, startsAt: new Date(a.settings.opensAt) }]
        : []),
      ...(a.settings.closesAt
        ? [{ kind: 'CLOSE' as const, title: a.name, startsAt: new Date(a.settings.closesAt) }]
        : []),
    ],
  },
  completion: {
    schema: z.object({
      endReached: bool(false),
      timeSpentMin: z.preprocess(
        (v) => (v === '' || v === null ? undefined : v),
        z.coerce.number().int().min(1).max(10_000).optional(),
      ),
    }),
    async evaluate(ctx, a, userId, rules) {
      const r = rules as { endReached?: boolean; timeSpentMin?: number };
      if (!r.endReached && !r.timeSpentMin) return 'complete';
      const attempts = await ctx.db.lessonAttempt.findMany({
        where: { activityId: a.id, userId, preview: false },
        select: { startedAt: true, finishedAt: true },
      });
      if (r.endReached && !attempts.some((x) => x.finishedAt)) return 'incomplete';
      if (r.timeSpentMin) {
        const ms = attempts.reduce(
          (sum, x) => sum + ((x.finishedAt ?? x.startedAt).getTime() - x.startedAt.getTime()),
          0,
        );
        if (ms < r.timeSpentMin * 60_000) return 'incomplete';
      }
      return 'complete';
    },
  },
  notifications: {
    needsGrading: { email: 'DIGEST' },
    graded: { email: 'IMMEDIATE' },
  },
  ai: {
    // the tutor reads the content pages only: questions and their answers stay out
    tutorPolicy: 'include',
    async extract(ctx, a) {
      return (await lessonPages(ctx.db, a.id))
        .filter((p) => p.type === 'content')
        .map((p) => ({ title: p.title, text: p.contents }));
    },
  },
  lifecycle: {
    // grading settings change every attempt's grade
    async onUpdate(ctx, ref, prev) {
      const a = ref as Lesson;
      const s = a.settings;
      if (s.closesAt !== prev.closesAt || s.timeLimitMin !== prev.timeLimitMin)
        await refreshOpenAttempts(ctx, a);
      const keys = [
        'practice',
        'gradeMax',
        'customScoring',
        'maxAttempts',
        'minQuestions',
        'useMaxGrade',
      ] as const;
      if (!keys.some((k) => s[k] !== prev[k])) return;
      await ctx.grades.syncItems(a.id);
      await regradeFinished(ctx, a);
    },
  },
  cron: [
    {
      name: 'lesson.overdue.sweep',
      schedule: '* * * * *',
      async handler(ctx) {
        // ends attempts whose time ran out while the learner was away (not yet those of
        // a time a local node may still bring answers for)
        const waiting = await ctx.nodes.waitingSince();
        const before = waiting && waiting < ctx.now ? waiting : ctx.now;
        const due = await ctx.db.lessonAttempt.findMany({
          where: { finishedAt: null, dueAt: { lt: before } },
          include: { activity: true },
          take: 200,
        });
        for (const at of due) {
          const s = LessonSettings.safeParse(at.activity.settings);
          if (!s.success) continue;
          const a = { ...at.activity, settings: s.data } as unknown as Lesson;
          await finishAttempt(ctx, a, at);
        }
        return { closed: due.length };
      },
    },
  ],
  reset: {
    async userData(ctx, a) {
      await ctx.db.lessonAttempt.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return {
        attempts: await ctx.db.lessonAttempt.findMany({
          where: { userId },
          select: {
            activityId: true,
            number: true,
            startedAt: true,
            finishedAt: true,
            percent: true,
            steps: {
              where: { kind: 'answer' },
              select: { pageId: true, response: true, correct: true, essayComment: true },
            },
          },
        }),
      };
    },
    async erase(ctx, userId) {
      await ctx.db.lessonAttempt.deleteMany({ where: { userId } });
    },
  },
  backup: {
    // the pages are the lesson; attempts are users' data
    async export(ctx, a) {
      return {
        pages: (await lessonPages(ctx.db, a.id)).map((p) => ({
          key: p.id,
          type: p.type,
          title: p.title,
          contents: p.contents,
          answers: p.answers,
          options: p.options,
        })),
      };
    },
    async import(ctx, a, data, map) {
      const parsed = z.object({ pages: z.array(z.unknown()).max(1000) }).safeParse(data);
      if (!parsed.success) return;
      await importPages(ctx.db, a.id, parsed.data.pages as z.input<typeof ExportedPage>[], map);
    },
  },
  queries: {
    pages: defineQuery({
      summary: 'The pages with their answers and jumps (for editors)',
      input: z.object({}),
      async handler(ctx, a) {
        await ctx.perm.require('mod.lesson:edit', a.id);
        return lessonPages(ctx.db, a.id);
      },
    }),
    state: defineQuery({
      summary: 'Your open attempt and its page, your past attempts and your grade',
      input: z.object({}),
      async handler(ctx, a) {
        return lessonState(ctx, a, uid(ctx));
      },
    }),
  },
  actions: {
    // ── editing ──
    addPage: defineAction({
      offline: 'replay',
      summary: 'Add a page after another one (or first)',
      capability: 'mod.lesson:edit',
      input: PageInput.extend({
        type: z.enum(pageTypes),
        afterId: z.string().uuid().nullable().default(null),
      }),
      async handler(ctx, a, input) {
        const pages = await lessonPages(ctx.db, a.id);
        const err = checkPage(input.type, input);
        if (err) throw new ModuleError('BAD_REQUEST', err);
        const id = opRandom().uuid();
        const answers = answerRows(input.answers, new Set([...pages.map((p) => p.id), id]));
        await ctx.db.lessonPage.create({
          data: {
            id,
            activityId: a.id,
            sortOrder: pages.length,
            type: input.type,
            title: input.title,
            contents: isStructure(input.type) ? '' : sanitizeRichText(input.contents),
            answers: answers as unknown as Prisma.InputJsonValue,
            options: input.options as Prisma.InputJsonValue,
          },
        });
        const order = pages.map((p) => p.id);
        const at = input.afterId ? order.indexOf(input.afterId) + 1 : 0;
        order.splice(at < 0 ? order.length : at, 0, id);
        await renumber(ctx.db, order);
        return { id };
      },
    }),
    updatePage: defineAction({
      offline: 'guarded',
      summary: 'Change a page (its kind stays)',
      capability: 'mod.lesson:edit',
      input: PageInput.extend({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        const row = await pageOf(ctx, a, input.id);
        const err = checkPage(row.type as PageType, input);
        if (err) throw new ModuleError('BAD_REQUEST', err);
        const pages = await lessonPages(ctx.db, a.id);
        const answers = answerRows(input.answers, new Set(pages.map((p) => p.id)));
        await ctx.db.lessonPage.update({
          where: { id: row.id },
          data: {
            title: input.title,
            contents: isStructure(row.type) ? '' : sanitizeRichText(input.contents),
            answers: answers as unknown as Prisma.InputJsonValue,
            options: input.options as Prisma.InputJsonValue,
          },
        });
        return { id: row.id };
      },
    }),
    movePage: defineAction({
      offline: 'guarded',
      summary: 'Move a page up or down',
      capability: 'mod.lesson:edit',
      input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
      async handler(ctx, a, input) {
        const order = (await lessonPages(ctx.db, a.id)).map((p) => p.id);
        const i = order.indexOf(input.id);
        if (i < 0) throw new ModuleError('NOT_FOUND', msg('mod.lesson.errors.noPage'));
        const j = input.direction === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= order.length) return { ok: true };
        [order[i], order[j]] = [order[j]!, order[i]!];
        await renumber(ctx.db, order);
        return { ok: true };
      },
    }),
    deletePage: defineAction({
      offline: 'guarded',
      summary: 'Delete a page (answers to it go with it; jumps to it lead on)',
      capability: 'mod.lesson:edit',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Lesson;
        const row = await pageOf(ctx, a, input.id);
        const order = (await lessonPages(ctx.db, a.id)).map((p) => p.id);
        const at = order.indexOf(row.id);
        // learners on it go on to the page after it (or before it, at the end)
        await ctx.db.lessonAttempt.updateMany({
          where: { activityId: a.id, finishedAt: null, currentPageId: row.id },
          data: { currentPageId: order[at + 1] ?? order[at - 1] ?? null },
        });
        const answered = await ctx.db.lessonStep.count({
          where: { pageId: row.id, kind: 'answer', attempt: { finishedAt: { not: null } } },
        });
        await ctx.db.lessonPage.delete({ where: { id: row.id } });
        await renumber(
          ctx.db,
          order.filter((id) => id !== row.id),
        );
        // its answers went with it: the attempts that had them are worked out again
        if (answered) await regradeFinished(ctx, a);
        return { ok: true };
      },
    }),
    // ── taking the lesson ──
    start: defineAction({
      offline: 'replay',
      summary:
        'Start the lesson or go on with the open attempt; `preview` for teachers; `password` when it has one',
      input: z.object({
        preview: z.boolean().default(false),
        password: z.string().max(255).optional(),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Lesson;
        const s = a.settings;
        const me = uid(ctx);
        await ctx.perm.require(
          input.preview ? 'mod.lesson:viewreports' : 'mod.lesson:attempt',
          a.id,
        );
        const open = await openAttempt(ctx, a, me);
        if (open) return { attemptId: open.id };
        if (!input.preview) {
          const w = lessonWindow(s, ctx.now);
          if (w)
            throw new ModuleError(
              'BAD_REQUEST',
              w === 'notOpen'
                ? msg('mod.lesson.errors.notOpenYet')
                : msg('mod.lesson.errors.closed'),
            );
          if (s.password && input.password !== s.password)
            throw new ModuleError('FORBIDDEN', msg('mod.lesson.errors.wrongPassword'));
          const done = await ctx.db.lessonAttempt.count({
            where: { activityId: a.id, userId: me, preview: false },
          });
          if (done && !s.retake)
            throw new ModuleError('CONFLICT', msg('mod.lesson.errors.noRetake'));
        }
        const pages = await lessonPages(ctx.db, a.id);
        if (!pages.length) throw new ModuleError('BAD_REQUEST', msg('mod.lesson.errors.noPages'));
        const last = await ctx.db.lessonAttempt.findFirst({
          where: { activityId: a.id, userId: me, preview: input.preview },
          orderBy: { number: 'desc' },
          select: { number: true },
        });
        const timeDue = s.timeLimitMin
          ? new Date(ctx.now.getTime() + s.timeLimitMin * 60_000)
          : null;
        const at = await ctx.db.lessonAttempt.create({
          data: {
            activityId: a.id,
            userId: me,
            number: (last?.number ?? 0) + 1,
            preview: input.preview,
            startedAt: ctx.now,
            // ends with the lesson's close date too, also when the learner has gone away
            dueAt: attemptEnds(a, { dueAt: timeDue, preview: input.preview }),
          },
        });
        await moveTo(ctx, a, at, pages[0]!.id);
        await ctx.log('lesson.attempt.started', { activityId: a.id, attemptId: at.id });
        return { attemptId: at.id };
      },
    }),
    choose: defineAction({
      offline: 'replay',
      summary: 'Press a button of the content page you are on',
      input: z.object({ pageId: z.string().uuid(), answerId: z.string().max(64) }),
      async handler(ctx, ref, input) {
        const a = ref as Lesson;
        const at = await requireOpen(ctx, a);
        if (at.currentPageId !== input.pageId)
          throw new ModuleError('CONFLICT', msg('mod.lesson.errors.otherPage'));
        const pages = await lessonPages(ctx.db, a.id);
        const page = pages.find((p) => p.id === input.pageId);
        const button =
          page?.type === 'content' && page.answers.find((x) => x.id === input.answerId);
        if (!button) throw new ModuleError('NOT_FOUND', msg('mod.lesson.errors.noButton'));
        const steps = engineSteps(await stepsOf(ctx.db, at.id));
        const next = await moveTo(
          ctx,
          a,
          at,
          resolveJump(pages, page.id, button.jump, steps, pick),
        );
        return { finished: next === END };
      },
    }),
    goTo: defineAction({
      offline: 'replay',
      summary: 'Go to a content page from the lesson menu',
      input: z.object({ pageId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Lesson;
        if (!a.settings.displayMenu)
          throw new ModuleError('FORBIDDEN', msg('mod.lesson.errors.noMenu'));
        const at = await requireOpen(ctx, a);
        const page = await pageOf(ctx, a, input.pageId);
        const options = pageFromRow(page).options;
        if (page.type !== 'content' || options.inMenu === false)
          throw new ModuleError('FORBIDDEN', msg('mod.lesson.errors.notInMenu'));
        await moveTo(ctx, a, at, page.id);
        return { ok: true };
      },
    }),
    answer: defineAction({
      offline: 'replay',
      summary:
        'Answer the question you are on: `choice`, `choices`, `text` (short answers, numbers, essays) or `matches`',
      input: z.object({
        pageId: z.string().uuid(),
        choice: z.string().max(64).optional(),
        choices: z.array(z.string().max(64)).max(50).optional(),
        text: z.string().max(100_000).optional(),
        matches: z.array(z.string().max(2000)).max(50).optional(),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Lesson;
        const s = a.settings;
        const at = await requireOpen(ctx, a);
        if (at.currentPageId !== input.pageId)
          throw new ModuleError('CONFLICT', msg('mod.lesson.errors.otherPage'));
        const pages = await lessonPages(ctx.db, a.id);
        const page = pages.find((p) => p.id === input.pageId)!;
        if (!isQuestion(page.type))
          throw new ModuleError('BAD_REQUEST', msg('mod.lesson.errors.noQuestion'));
        const rows = await stepsOf(ctx.db, at.id);
        const r: Response =
          input.choices !== undefined
            ? { choices: input.choices }
            : input.choice !== undefined
              ? { choice: input.choice }
              : input.matches !== undefined
                ? { matches: input.matches }
                : { text: input.text ?? '' };
        if (page.type === 'essay' && !('text' in r && r.text.trim()))
          throw new ModuleError('BAD_REQUEST', msg('mod.lesson.errors.writeAnswer'));
        // a short answer or a number is short: only an essay is long
        if (page.type !== 'essay' && 'text' in r && r.text.length > SHORT_ANSWER_MAX)
          throw new ModuleError('BAD_REQUEST', msg('mod.lesson.errors.answerTooLong'));
        const checked = checkResponse(pages, page, r, s.customScoring);
        const essay = page.type === 'essay';
        await addStep(ctx, at.id, {
          pageId: page.id,
          kind: 'answer',
          answerId: checked.answer?.id ?? null,
          response: (essay ? { text: (r as { text: string }).text } : r) as Prisma.InputJsonValue,
          correct: checked.correct,
          score: checked.score,
        });
        const tries = rows.filter((x) => x.kind === 'answer' && x.pageId === page.id).length + 1;
        let target = checked.answer
          ? resolveJump(pages, page.id, checked.answer.jump, engineSteps(rows), pick)
          : page.id;
        const i = pages.indexOf(page);
        const onward = (t: string) => (t === page.id ? (pages[i + 1]?.id ?? END) : t);
        const retry = !checked.correct && !essay && tries < s.maxAttempts;
        // no tries left: on to the next page rather than the same question again
        if (!checked.correct && !essay && !retry) target = onward(target);
        let next: string = page.id;
        if (!(retry && s.review)) next = await moveTo(ctx, a, at, target);
        if (essay && !at.preview) {
          const graders = await ctx.perm.usersWithCap('mod.lesson:grade', a.id);
          await ctx.notify.send(graders, {
            type: 'lesson.needsGrading',
            title: { key: 'mod.lesson.notify.needsGradingTitle', values: { name: a.name } },
            url: `/course/${a.courseId}/a/${a.id}?tab=essays`,
            courseId: a.courseId,
            contextId: a.id,
          });
        }
        return {
          correct: checked.correct,
          essay,
          response: checked.answer?.response ?? '',
          /** Try again or go on (the lesson offers the choice). */
          retry: retry && s.review,
          finished: next === END,
        };
      },
    }),
    skip: defineAction({
      offline: 'replay',
      summary: 'Leave a question answered wrongly instead of trying again',
      input: z.object({ pageId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Lesson;
        const at = await requireOpen(ctx, a);
        if (at.currentPageId !== input.pageId)
          throw new ModuleError('CONFLICT', msg('mod.lesson.errors.otherPage'));
        const [pages, rows] = await Promise.all([
          lessonPages(ctx.db, a.id),
          stepsOf(ctx.db, at.id),
        ]);
        const last = rows[rows.length - 1];
        if (last?.kind !== 'answer' || last.pageId !== input.pageId || last.correct)
          throw new ModuleError('CONFLICT', msg('mod.lesson.errors.answerFirst'));
        const page = pages.find((p) => p.id === input.pageId)!;
        const answer = page.answers.find((x) => x.id === last.answerId);
        let target = answer
          ? resolveJump(pages, page.id, answer.jump, engineSteps(rows), pick)
          : page.id;
        if (target === page.id) target = pages[pages.indexOf(page) + 1]?.id ?? END;
        const next = await moveTo(ctx, a, at, target);
        return { finished: next === END };
      },
    }),
    // ── teachers ──
    gradeEssay: defineAction({
      offline: 'guarded',
      summary: 'Grade an essay answer: points (up to the answer’s, or 1) and a comment',
      capability: 'mod.lesson:grade',
      input: z.object({
        stepId: z.string().uuid(),
        score: z.number().min(0).max(1000),
        comment: z.string().max(10_000).default(''),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Lesson;
        const step = await ctx.db.lessonStep.findUnique({
          where: { id: input.stepId },
          include: { attempt: true, page: true },
        });
        if (
          step?.kind !== 'answer' ||
          step.attempt.activityId !== a.id ||
          step.page.type !== 'essay'
        )
          throw new ModuleError('NOT_FOUND', msg('mod.lesson.errors.noEssay'));
        const max = a.settings.customScoring
          ? Math.max(0, ...pageFromRow(step.page).answers.map((x) => x.score))
          : 1;
        if (input.score > max)
          throw new ModuleError('BAD_REQUEST', msg('mod.lesson.errors.essayPoints', { max }));
        await ctx.db.lessonStep.update({
          where: { id: step.id },
          data: {
            essayScore: input.score,
            essayComment: input.comment.trim(),
            gradedAt: ctx.now,
            correct: input.score > 0,
          },
        });
        if (step.attempt.finishedAt) {
          const [pages, rows] = await Promise.all([
            lessonPages(ctx.db, a.id),
            stepsOf(ctx.db, step.attemptId),
          ]);
          await ctx.db.lessonAttempt.update({
            where: { id: step.attemptId },
            data: { percent: gradeOf(a.settings, pages, rows).percent },
          });
          if (!step.attempt.preview) await pushGrade(ctx, a, step.attempt.userId);
        }
        await ctx.notify.send([step.attempt.userId], {
          type: 'lesson.graded',
          title: { key: 'mod.lesson.notify.gradedTitle', values: { name: a.name } },
          url: `/course/${a.courseId}/a/${a.id}`,
          courseId: a.courseId,
          contextId: a.id,
        });
        return { ok: true };
      },
    }),
    deleteAttempt: defineAction({
      offline: 'guarded',
      summary: 'Delete an attempt of a learner (their grade is reckoned again)',
      capability: 'mod.lesson:grade',
      input: z.object({ attemptId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Lesson;
        const at = await ctx.db.lessonAttempt.findFirst({
          where: { id: input.attemptId, activityId: a.id },
        });
        if (!at) throw new ModuleError('NOT_FOUND', msg('mod.lesson.errors.noAttempt'));
        await ctx.db.lessonAttempt.delete({ where: { id: at.id } });
        if (!at.preview) {
          await pushGrade(ctx, a, at.userId);
          await ctx.completion.recompute(a.id, at.userId);
        }
        return { ok: true };
      },
    }),
  },
});

/**
 * The lesson's learners by name, a page of them at a time, each with their attempts and
 * grade (for the report).
 */
export async function lessonReport(
  ctx: ModuleCtx,
  ref: ActivityRef,
  opts: { page?: number; pageSize?: number } = {},
) {
  const a = ref as Lesson;
  const where = { activityId: a.id, preview: false };
  const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 25)));
  // who has attempts is read without them; the steps are read for one page of people only
  const everyone = (
    await ctx.db.lessonAttempt.findMany({
      where,
      distinct: ['userId'],
      select: { user: { select: { id: true, name: true } } },
    })
  )
    .map((r) => r.user)
    .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
  const pages = Math.max(1, Math.ceil(everyone.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(opts.page ?? 1)));
  const users = everyone.slice((page - 1) * pageSize, page * pageSize);
  const [lesson, attempts] = await Promise.all([
    lessonPages(ctx.db, a.id),
    users.length
      ? ctx.db.lessonAttempt.findMany({
          where: { ...where, userId: { in: users.map((u) => u.id) } },
          orderBy: [{ number: 'asc' }],
          include: { steps: { orderBy: { seq: 'asc' } } },
        })
      : [],
  ]);
  const titles = new Map(lesson.map((p) => [p.id, p.title]));
  const rows = attempts.map((at) => {
    const g = gradeOf(a.settings, lesson, at.steps);
    return {
      id: at.id,
      userId: at.userId,
      number: at.number,
      startedAt: at.startedAt,
      finishedAt: at.finishedAt,
      percent: at.finishedAt ? at.percent : null,
      earned: g.earned,
      total: g.total,
      pending: g.pending,
      answers: at.steps
        .filter((st) => st.kind === 'answer')
        .map((st) => ({
          id: st.id,
          page: titles.get(st.pageId) ?? '',
          response: st.response as Response | null,
          correct: st.correct,
          essayScore: st.essayScore,
        })),
    };
  });
  return {
    total: everyone.length,
    page,
    pageSize,
    users: users.map((user) => {
      const list = rows.filter((r) => r.userId === user.id);
      return {
        user,
        attempts: list,
        percent: lessonPercent(
          list.filter((x) => x.finishedAt).map((x) => x.percent),
          a.settings.useMaxGrade,
        ),
      };
    }),
  };
}

/** Essay answers with their grading, ungraded first (for teachers). */
export async function lessonEssays(ctx: ModuleCtx, ref: ActivityRef) {
  const a = ref as Lesson;
  const rows = await ctx.db.lessonStep.findMany({
    where: {
      kind: 'answer',
      page: { activityId: a.id, type: 'essay' },
      attempt: { preview: false },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      page: true,
      attempt: { select: { number: true, user: { select: { id: true, name: true } } } },
    },
  });
  return rows
    .map((st) => {
      const page = pageFromRow(st.page);
      return {
        id: st.id,
        user: st.attempt.user,
        attempt: st.attempt.number,
        page: page.title,
        question: page.contents,
        text: (st.response as { text?: string } | null)?.text ?? '',
        score: st.essayScore,
        comment: st.essayComment,
        max: a.settings.customScoring ? Math.max(0, ...page.answers.map((x) => x.score)) : 1,
        createdAt: st.createdAt,
      };
    })
    .sort((x, y) => Number(x.score !== null) - Number(y.score !== null));
}

export { defaultStructureJump };
export const lessonModules = [lesson];
