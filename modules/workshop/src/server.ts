import { randomUUID } from 'node:crypto';
import type { Prisma } from '@hubium/db';
import { isEmptyRichText, sanitizeRichText } from '@hubium/editor/server';
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
import { groupsWhere } from '@hubium/module-sdk/groups';
import { FileInput } from '@hubium/module-sdk/inputs';
import { z } from 'zod';
import {
  assessmentGrade,
  bestEvaluation,
  comparisons,
  type Dimension,
  dimensionGrades,
  type Filling,
  fillingError,
  gradingGrade,
  type Phase,
  phases,
  randomAllocation,
  type Strategy,
  strategies,
  submissionGrade,
  type WorkshopForm,
} from './engine.ts';

// mod-workshop: peer assessment, as Moodle's workshop. It goes through phases the
// teacher switches: setup (the assessment form), submission (learners hand in work),
// assessment (reviewers allocated by hand or at random fill the form for others'
// work), grading evaluation (grades for the work from its assessments and grades for
// assessing from their agreement with the best assessment) and closed (the grades go to
// the gradebook). The rules are in engine.ts.

const html = z
  .string()
  .max(200_000)
  .default('')
  .transform((v) => (v.trim() ? sanitizeRichText(v) : ''));
const presence = z.enum(['required', 'optional', 'off']);

export const WorkshopSettings = z
  .object({
    strategy: z.enum(strategies).default('accumulative'),
    gradeMax: z.coerce.number().min(0).max(1000).default(80),
    gradePass: optionalNumber(0, 1000),
    gradingGradeMax: z.coerce.number().min(0).max(1000).default(20),
    gradingGradePass: optionalNumber(0, 1000),
    instructAuthors: html,
    instructReviewers: html,
    conclusion: html,
    submissionText: presence.default('required'),
    submissionFiles: presence.default('optional'),
    maxAttachments: z.coerce.number().int().min(0).max(20).default(1),
    maxFileMB: z.coerce.number().int().min(1).max(1024).default(10),
    /** Work may come after the deadline (and then is not changed). */
    lateSubmissions: bool(false),
    submissionStart: isoDate,
    submissionEnd: isoDate,
    assessmentStart: isoDate,
    assessmentEnd: isoDate,
    /** The assessment phase begins by itself when submissions end. */
    phaseSwitch: bool(false),
    /** Learners may assess their own work too. */
    selfAssessment: bool(false),
    /** How strictly assessments are compared: 9 very lax … 1 very strict. */
    comparison: z.coerce
      .number()
      .int()
      .refine((n) => (comparisons as readonly number[]).includes(n))
      .default(5),
  })
  .refine((s) => s.submissionText !== 'off' || s.submissionFiles !== 'off', {
    message: 'mod.workshop.errors.allowSomething',
    path: ['submissionText'],
  })
  .refine((s) => !s.submissionStart || !s.submissionEnd || s.submissionEnd > s.submissionStart, {
    message: 'mod.workshop.errors.submissionsEnd',
    path: ['submissionEnd'],
  })
  .refine((s) => !s.assessmentStart || !s.assessmentEnd || s.assessmentEnd > s.assessmentStart, {
    message: 'mod.workshop.errors.assessmentEnd',
    path: ['assessmentEnd'],
  })
  .refine((s) => s.gradePass === undefined || s.gradePass <= s.gradeMax, {
    message: 'errors.common.passGradeAboveMax',
    path: ['gradePass'],
  })
  .refine((s) => s.gradingGradePass === undefined || s.gradingGradePass <= s.gradingGradeMax, {
    message: 'errors.common.passGradeAboveMax',
    path: ['gradingGradePass'],
  });
export type WorkshopSettingsT = z.output<typeof WorkshopSettings>;
type Ws = ActivityRef<WorkshopSettingsT>;

const uid = (ctx: ModuleCtx) => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);
const me = (ctx: ModuleCtx) => {
  const id = uid(ctx);
  if (!id) throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
  return id;
};

// ── state and form ──

export async function workshopState(db: Prisma.TransactionClient, activityId: string) {
  const row = await db.workshop.findUnique({ where: { activityId } });
  return {
    phase: (row?.phase ?? 'setup') as Phase,
    forms: (row?.forms ?? {}) as Partial<Record<Strategy, Omit<WorkshopForm, 'strategy'>>>,
  };
}

export async function formOf(db: Prisma.TransactionClient, a: ActivityRef): Promise<WorkshopForm> {
  const s = (a as Ws).settings;
  const f = (await workshopState(db, a.id)).forms[s.strategy];
  return { strategy: s.strategy, dimensions: f?.dimensions ?? [], mapping: f?.mapping };
}

const DimensionInput = z.object({
  id: z.string().max(64).optional(),
  description: z.string().max(20_000).default(''),
  maxGrade: z.coerce.number().min(1).max(1000).optional(),
  weight: z.coerce.number().int().min(0).max(16).optional(),
  positive: z.string().trim().max(255).optional(),
  negative: z.string().trim().max(255).optional(),
  levels: z
    .array(
      z.object({
        id: z.string().max(64).optional(),
        grade: z.coerce.number().min(-1000).max(1000),
        definition: z.string().trim().max(2000).default(''),
      }),
    )
    .max(20)
    .optional(),
});

/** A form as stored: ids given, each dimension what its strategy needs. */
export function cleanForm(
  strategy: Strategy,
  dims: z.output<typeof DimensionInput>[],
  mapping: Record<string, number> = {},
): Omit<WorkshopForm, 'strategy'> {
  if (!dims.length) throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.formEmpty'));
  const dimensions: Dimension[] = dims.map((d, i) => {
    const description = d.description.trim() ? sanitizeRichText(d.description) : '';
    if (!description || isEmptyRichText(description))
      throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.describeAspect', { n: i + 1 }));
    const id = d.id && /^[\w-]{1,64}$/.test(d.id) ? d.id : randomUUID();
    if (strategy === 'accumulative') {
      if (!d.maxGrade)
        throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.maxPoints', { n: i + 1 }));
      return { id, description, maxGrade: d.maxGrade, weight: d.weight ?? 1 };
    }
    if (strategy === 'numerrors')
      return {
        id,
        description,
        weight: d.weight ?? 1,
        positive: d.positive || undefined,
        negative: d.negative || undefined,
      };
    if (strategy === 'rubric') {
      const levels = (d.levels ?? []).map((l) => ({
        id: l.id && /^[\w-]{1,64}$/.test(l.id) ? l.id : randomUUID(),
        grade: l.grade,
        definition: l.definition,
      }));
      if (levels.length < 2)
        throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.twoLevels', { n: i + 1 }));
      return { id, description, levels };
    }
    return { id, description };
  });
  const clean: Record<string, number> = {};
  if (strategy === 'numerrors')
    for (const [k, v] of Object.entries(mapping))
      if (/^\d{1,3}$/.test(k) && Number.isFinite(v)) clean[k] = Math.max(0, Math.min(100, v));
  return strategy === 'numerrors' ? { dimensions, mapping: clean } : { dimensions };
}

// ── who sees what ──

async function rights(ctx: ModuleCtx, a: ActivityRef) {
  const [manage, viewAll, submit, assess, authorNames, reviewerNames] = await Promise.all([
    ctx.perm.can('mod.workshop:manage', a.id),
    ctx.perm.can('mod.workshop:viewall', a.id),
    ctx.perm.can('mod.workshop:submit', a.id),
    ctx.perm.can('mod.workshop:peerassess', a.id),
    ctx.perm.can('mod.workshop:viewauthornames', a.id),
    ctx.perm.can('mod.workshop:viewreviewernames', a.id),
  ]);
  return { manage, viewAll: viewAll || manage, submit, assess, authorNames, reviewerNames };
}

const submissionInclude = {
  author: { select: { id: true, name: true } },
  assessments: {
    include: { reviewer: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.WorkshopSubmissionInclude;
type SubmissionRow = Prisma.WorkshopSubmissionGetPayload<{ include: typeof submissionInclude }>;

/**
 * A submission as the user may see it, with the assessments they may see: their own
 * work's from the evaluation on, their own assessments, and every one for teachers.
 */
export async function submissionView(ctx: ModuleCtx, ref: ActivityRef, id: string) {
  const a = ref as Ws;
  const user = uid(ctx);
  const [s, r, { phase }] = await Promise.all([
    ctx.db.workshopSubmission.findFirst({
      where: { id, activityId: a.id },
      include: submissionInclude,
    }),
    rights(ctx, a),
    workshopState(ctx.db, a.id),
  ]);
  if (!s) return null;
  const own = s.authorId === user;
  const reviewing = s.assessments.some((x) => x.reviewerId === user);
  const published = s.published && phase === 'closed';
  if (!r.viewAll && !own && !reviewing && !published) return null;
  const later = phase === 'evaluation' || phase === 'closed';
  const assessments = s.assessments.filter(
    (x) => r.viewAll || x.reviewerId === user || (own && later && x.assessedAt),
  );
  return {
    submission: s,
    own,
    phase,
    rights: r,
    authorName: own || r.authorNames || r.viewAll ? s.author.name : null,
    assessments: assessments.map((x) => ({
      ...x,
      reviewerName: x.reviewerId === user || r.reviewerNames || r.viewAll ? x.reviewer.name : null,
    })),
  };
}

/** The workshop as the user sees it: phase, their work and reviews, or everything for teachers. */
export async function workshopOverview(ctx: ModuleCtx, ref: ActivityRef) {
  const a = ref as Ws;
  const user = uid(ctx);
  const [state, r] = await Promise.all([workshopState(ctx.db, a.id), rights(ctx, a)]);
  const rows = await ctx.db.workshopSubmission.findMany({
    where: r.viewAll
      ? { activityId: a.id }
      : {
          activityId: a.id,
          OR: [
            { authorId: user ?? '' },
            { assessments: { some: { reviewerId: user ?? '' } } },
            ...(state.phase === 'closed' ? [{ published: true }] : []),
          ],
        },
    include: submissionInclude,
    orderBy: { createdAt: 'asc' },
  });
  const mine = rows.find((s) => s.authorId === user) ?? null;
  const toReview = rows.flatMap((s) =>
    s.assessments
      .filter((x) => x.reviewerId === user)
      .map((x) => ({
        assessmentId: x.id,
        submissionId: s.id,
        title: s.title,
        author: r.authorNames || s.authorId === user ? s.author.name : null,
        assessed: !!x.assessedAt,
        self: s.authorId === user,
      })),
  );
  // a reviewer's grade for assessing: their assessments' grades (teacher's where given)
  const given = new Map<string, (number | null)[]>();
  for (const s of rows)
    for (const x of s.assessments)
      given.set(x.reviewerId, [
        ...(given.get(x.reviewerId) ?? []),
        x.gradingGradeOver ?? x.gradingGrade,
      ]);
  return {
    phase: state.phase,
    rights: r,
    mine,
    toReview,
    published:
      state.phase === 'closed' ? rows.filter((s) => s.published && s.authorId !== user) : [],
    myGradingGrade: user ? gradingGrade(given.get(user) ?? []) : null,
    all: r.viewAll
      ? rows.map((s) => ({
          id: s.id,
          title: s.title,
          author: s.author,
          late: s.late,
          grade: s.gradeOver ?? s.grade,
          overridden: s.gradeOver !== null,
          published: s.published,
          received: s.assessments.map((x) => ({
            id: x.id,
            reviewer: x.reviewer,
            grade: x.grade,
            gradingGrade: x.gradingGradeOver ?? x.gradingGrade,
            weight: x.weight,
          })),
        }))
      : [],
    reviewers: r.viewAll
      ? [...given.entries()].map(([id, grades]) => ({ id, grade: gradingGrade(grades) }))
      : [],
  };
}

// ── grades ──

/** The gradebook: work and assessing, in points; only once the workshop is closed. */
async function pushGrades(ctx: ModuleCtx, a: Ws, onlyUsers?: string[]) {
  const s = a.settings;
  if ((await workshopState(ctx.db, a.id)).phase !== 'closed') return;
  const subs = await ctx.db.workshopSubmission.findMany({
    where: { activityId: a.id },
    include: { assessments: true },
  });
  const points = (pct: number | null, max: number) =>
    pct === null ? null : Math.round((pct / 100) * max * 100_000) / 100_000;
  const grades: { userId: string; itemNumber: number; rawGrade: number | null }[] = [];
  const given = new Map<string, (number | null)[]>();
  for (const sub of subs) {
    grades.push({
      userId: sub.authorId,
      itemNumber: 0,
      rawGrade: points(sub.gradeOver ?? sub.grade, s.gradeMax),
    });
    for (const x of sub.assessments)
      given.set(x.reviewerId, [
        ...(given.get(x.reviewerId) ?? []),
        x.gradingGradeOver ?? x.gradingGrade,
      ]);
  }
  for (const [userId, list] of given)
    grades.push({ userId, itemNumber: 1, rawGrade: points(gradingGrade(list), s.gradingGradeMax) });
  const chosen = onlyUsers ? grades.filter((g) => onlyUsers.includes(g.userId)) : grades;
  if (chosen.length) await ctx.grades.setGrades(a.id, chosen);
}

/** Submission grades from their assessments, and grades for assessing (evaluation phase). */
export async function calculateGrades(ctx: ModuleCtx, a: Ws, comparison: number) {
  const form = await formOf(ctx.db, a);
  const subs = await ctx.db.workshopSubmission.findMany({
    where: { activityId: a.id },
    include: { assessments: true },
  });
  for (const sub of subs) {
    const assessed = sub.assessments.filter((x) => x.assessedAt);
    await ctx.db.workshopSubmission.update({
      where: { id: sub.id },
      data: {
        grade: submissionGrade(assessed.map((x) => ({ grade: x.grade, weight: x.weight }))),
      },
    });
    const evaluated = bestEvaluation(
      assessed.map((x) => ({
        id: x.id,
        weight: x.weight,
        dims: dimensionGrades(form, (x.filling ?? {}) as Filling),
      })),
      comparison,
    );
    for (const x of sub.assessments)
      await ctx.db.workshopAssessment.update({
        where: { id: x.id },
        data: { gradingGrade: evaluated.get(x.id) ?? null },
      });
  }
}

// ── the module ──

async function submissionOf(ctx: ModuleCtx, a: ActivityRef, id: string) {
  const s = await ctx.db.workshopSubmission.findFirst({ where: { id, activityId: a.id } });
  if (!s) throw new ModuleError('NOT_FOUND', msg('mod.workshop.errors.noSubmission'));
  return s;
}

async function assessmentOf(ctx: ModuleCtx, a: ActivityRef, id: string) {
  const x = await ctx.db.workshopAssessment.findFirst({
    where: { id, submission: { activityId: a.id } },
    include: { submission: true },
  });
  if (!x) throw new ModuleError('NOT_FOUND', msg('mod.workshop.errors.noAssessment'));
  return x;
}

const within = (now: Date, from: string | null, to: string | null) =>
  (!from || now >= new Date(from)) && (!to || now <= new Date(to));

export const workshop = defineModule<WorkshopSettingsT>({
  key: 'workshop',
  archetype: 'activity',
  icon: 'Users',
  supports: { viewCompletion: true, groups: true },
  settings: {
    schema: WorkshopSettings as unknown as z.ZodType<WorkshopSettingsT>,
    defaults: () => WorkshopSettings.parse({}),
  },
  grading: {
    items: (a) => [
      {
        itemNumber: 0,
        name: 'Submission',
        nameKey: 'mod.workshop.gradeItem.submission',
        gradeMax: a.settings.gradeMax,
        gradePass: a.settings.gradePass,
      },
      {
        itemNumber: 1,
        name: 'Assessment',
        nameKey: 'mod.workshop.gradeItem.assessment',
        gradeMax: a.settings.gradingGradeMax,
        gradePass: a.settings.gradingGradePass,
      },
    ],
  },
  calendar: {
    events: (a) =>
      (
        [
          ['OPEN', a.settings.submissionStart],
          ['DUE', a.settings.submissionEnd],
          ['OPEN', a.settings.assessmentStart],
          ['CLOSE', a.settings.assessmentEnd],
        ] as const
      ).flatMap(([kind, at]) => (at ? [{ kind, title: a.name, startsAt: new Date(at) }] : [])),
  },
  completion: {
    schema: z.object({ submitted: bool(false), assessed: bool(false) }),
    async evaluate(ctx, a, userId, rules) {
      const r = rules as { submitted?: boolean; assessed?: boolean };
      if (r.submitted) {
        const n = await ctx.db.workshopSubmission.count({
          where: { activityId: a.id, authorId: userId },
        });
        if (!n) return 'incomplete';
      }
      if (r.assessed) {
        const open = await ctx.db.workshopAssessment.count({
          where: { reviewerId: userId, submission: { activityId: a.id }, assessedAt: null },
        });
        const done = await ctx.db.workshopAssessment.count({
          where: {
            reviewerId: userId,
            submission: { activityId: a.id },
            assessedAt: { not: null },
          },
        });
        if (open || !done) return 'incomplete';
      }
      return 'complete';
    },
  },
  notifications: {
    allocated: { email: 'IMMEDIATE' },
    phase: { email: 'OFF', inApp: true },
  },
  files: {
    // a submission's files: whoever may see the submission
    submission: {
      async canRead(ctx, a, f) {
        return !!f.itemId && !!(await submissionView(ctx, a, f.itemId));
      },
    },
  },
  ai: { tutorPolicy: 'exclude' },
  cron: [
    {
      name: 'workshop.phase.switch',
      schedule: '*/5 * * * *',
      async handler(ctx) {
        // workshops whose submissions ended go on to assessment, if they are set to
        const rows = await ctx.db.workshop.findMany({
          where: { phase: 'submission' },
          include: { activity: true },
          take: 500,
        });
        let switched = 0;
        for (const w of rows) {
          const s = WorkshopSettings.safeParse(w.activity.settings);
          if (!s.success || !s.data.phaseSwitch || !s.data.submissionEnd) continue;
          if (new Date(s.data.submissionEnd) > ctx.now) continue;
          await ctx.db.workshop.update({
            where: { activityId: w.activityId },
            data: { phase: 'assessment' },
          });
          switched++;
        }
        return { switched };
      },
    },
  ],
  reset: {
    async userData(ctx, a) {
      const files = await ctx.files.list(a.id, 'submission');
      if (files.length)
        await ctx.files.remove(
          a.id,
          'submission',
          files.map((f) => f.id),
        );
      await ctx.db.workshopSubmission.deleteMany({ where: { activityId: a.id } });
      await ctx.db.workshop.updateMany({ where: { activityId: a.id }, data: { phase: 'setup' } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return {
        submissions: await ctx.db.workshopSubmission.findMany({
          where: { authorId: userId },
          select: { activityId: true, title: true, content: true, grade: true, createdAt: true },
        }),
        assessments: await ctx.db.workshopAssessment.findMany({
          where: { reviewerId: userId },
          select: { submissionId: true, grade: true, feedbackAuthor: true, assessedAt: true },
        }),
      };
    },
    async erase(ctx, userId) {
      await ctx.db.workshopAssessment.deleteMany({ where: { reviewerId: userId } });
      const subs = await ctx.db.workshopSubmission.findMany({
        where: { authorId: userId },
        select: { id: true, activityId: true },
      });
      for (const s of subs) {
        const files = await ctx.files.list(s.activityId, 'submission', s.id);
        if (files.length)
          await ctx.files.remove(
            s.activityId,
            'submission',
            files.map((f) => f.id),
            s.id,
          );
      }
      await ctx.db.workshopSubmission.deleteMany({ where: { authorId: userId } });
    },
  },
  backup: {
    userFileAreas: ['submission'],
    // the assessment forms (and the settings) make the workshop; work and reviews are users'
    async export(ctx, a) {
      return { forms: (await workshopState(ctx.db, a.id)).forms };
    },
    async import(ctx, a, raw) {
      const parsed = z
        .object({
          forms: z.record(
            z.string(),
            z.object({
              dimensions: z.array(DimensionInput),
              mapping: z.record(z.string(), z.number()).optional(),
            }),
          ),
        })
        .safeParse(raw);
      if (!parsed.success) return;
      const forms: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(parsed.data.forms)) {
        if (!(strategies as readonly string[]).includes(k) || !f.dimensions.length) continue;
        try {
          forms[k] = cleanForm(k as Strategy, f.dimensions, f.mapping);
        } catch {
          // a form the workshop cannot take is left out
        }
      }
      await ctx.db.workshop.upsert({
        where: { activityId: a.id },
        create: { activityId: a.id, forms: forms as Prisma.InputJsonValue },
        update: { forms: forms as Prisma.InputJsonValue },
      });
    },
  },
  lifecycle: {
    async onCreate(ctx, a) {
      await ctx.db.workshop.upsert({
        where: { activityId: a.id },
        create: { activityId: a.id },
        update: {},
      });
    },
    // new maxima change the gradebook's points once the workshop is closed
    async onUpdate(ctx, ref, prev) {
      const a = ref as Ws;
      if (
        a.settings.gradeMax !== prev.gradeMax ||
        a.settings.gradingGradeMax !== prev.gradingGradeMax
      )
        await pushGrades(ctx, a);
    },
  },
  queries: {
    overview: defineQuery({
      summary: 'The phase, your work and the work you review (everything for teachers)',
      input: z.object({}),
      async handler(ctx, a) {
        const o = await workshopOverview(ctx, a);
        return {
          phase: o.phase,
          mine: o.mine && { id: o.mine.id, title: o.mine.title },
          toReview: o.toReview,
          myGradingGrade: o.myGradingGrade,
          all: o.all,
        };
      },
    }),
    form: defineQuery({
      summary: 'The assessment form of the workshop’s grading strategy',
      input: z.object({}),
      async handler(ctx, a) {
        return formOf(ctx.db, a);
      },
    }),
  },
  actions: {
    // ── the teacher ──
    switchPhase: defineAction({
      summary: 'Move the workshop to a phase (closing it puts the grades into the gradebook)',
      capability: 'mod.workshop:manage',
      input: z.object({ phase: z.enum(phases) }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        if (input.phase !== 'setup' && !(await formOf(ctx.db, a)).dimensions.length)
          throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.formFirst'));
        await ctx.db.workshop.upsert({
          where: { activityId: a.id },
          create: { activityId: a.id, phase: input.phase },
          update: { phase: input.phase },
        });
        if (input.phase === 'closed') await pushGrades(ctx, a);
        const people = await ctx.perm.usersWithCap('mod.workshop:submit', a.id);
        await ctx.notify.send(people, {
          type: 'workshop.phase',
          title: {
            key: 'mod.workshop.notify.phaseTitle',
            values: { name: a.name, phase: input.phase },
          },
          url: `/course/${a.courseId}/a/${a.id}`,
          courseId: a.courseId,
          contextId: a.id,
        });
        await ctx.log('workshop.phase', { activityId: a.id, phase: input.phase });
        return { ok: true };
      },
    }),
    saveForm: defineAction({
      summary: 'Write the assessment form of the grading strategy (before anyone assesses)',
      capability: 'mod.workshop:manage',
      input: z.object({
        dimensions: z.array(DimensionInput).min(1).max(50),
        mapping: z.record(z.string(), z.coerce.number()).default({}),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        const used = await ctx.db.workshopAssessment.count({
          where: { submission: { activityId: a.id }, assessedAt: { not: null } },
        });
        if (used) throw new ModuleError('CONFLICT', msg('mod.workshop.errors.formInUse'));
        const state = await workshopState(ctx.db, a.id);
        const forms = {
          ...state.forms,
          [a.settings.strategy]: cleanForm(a.settings.strategy, input.dimensions, input.mapping),
        };
        await ctx.db.workshop.upsert({
          where: { activityId: a.id },
          create: { activityId: a.id, forms: forms as Prisma.InputJsonValue },
          update: { forms: forms as Prisma.InputJsonValue },
        });
        return { ok: true };
      },
    }),
    allocate: defineAction({
      summary: 'Have a learner assess a submission',
      capability: 'mod.workshop:manage',
      input: z.object({ submissionId: z.string().uuid(), reviewerId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        const sub = await submissionOf(ctx, a, input.submissionId);
        if (sub.authorId === input.reviewerId && !a.settings.selfAssessment)
          throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.noSelfAssessment'));
        const reviewers = await ctx.perm.usersWithCap('mod.workshop:peerassess', a.id);
        if (!reviewers.includes(input.reviewerId))
          throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.notAnAssessor'));
        const x = await ctx.db.workshopAssessment.upsert({
          where: {
            submissionId_reviewerId: { submissionId: sub.id, reviewerId: input.reviewerId },
          },
          create: { submissionId: sub.id, reviewerId: input.reviewerId },
          update: {},
        });
        await ctx.notify.send([input.reviewerId], {
          type: 'workshop.allocated',
          title: { key: 'mod.workshop.notify.allocatedTitle', values: { name: a.name } },
          url: `/course/${a.courseId}/a/${a.id}?assess=${x.id}`,
          courseId: a.courseId,
          contextId: a.id,
        });
        return { id: x.id };
      },
    }),
    deallocate: defineAction({
      summary: 'Take an allocation back (its assessment goes with it)',
      capability: 'mod.workshop:manage',
      input: z.object({ assessmentId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const x = await assessmentOf(ctx, ref, input.assessmentId);
        // grades are worked out from the assessments in the evaluation phase: taking one
        // back afterwards would leave grades that no assessment backs
        const { phase } = await workshopState(ctx.db, ref.id);
        if (x.assessedAt && (phase === 'evaluation' || phase === 'closed'))
          throw new ModuleError('CONFLICT', msg('mod.workshop.errors.assessmentUsed'));
        await ctx.db.workshopAssessment.delete({ where: { id: x.id } });
        return { ok: true };
      },
    }),
    randomAllocate: defineAction({
      summary:
        'Allocate at random: `count` reviews per submission or per reviewer, apart from groupmates if asked',
      capability: 'mod.workshop:manage',
      input: z.object({
        count: z.number().int().min(1).max(30),
        per: z.enum(['submission', 'reviewer']).default('submission'),
        excludeSameGroup: z.boolean().default(false),
        addSelf: z.boolean().default(false),
        removeCurrent: z.boolean().default(false),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        if (input.removeCurrent)
          await ctx.db.workshopAssessment.deleteMany({
            where: { submission: { activityId: a.id }, assessedAt: null },
          });
        const [subs, reviewerIds, existing] = await Promise.all([
          ctx.db.workshopSubmission.findMany({
            where: { activityId: a.id },
            select: { id: true, authorId: true },
          }),
          ctx.perm.usersWithCap('mod.workshop:peerassess', a.id),
          ctx.db.workshopAssessment.findMany({
            where: { submission: { activityId: a.id } },
            select: { submissionId: true, reviewerId: true },
          }),
        ]);
        const members =
          a.groupMode === 'NONE'
            ? []
            : await ctx.db.groupMember.findMany({
                where: { group: groupsWhere(a) },
                select: { userId: true, groupId: true },
              });
        const groups = (u: string) => members.filter((m) => m.userId === u).map((m) => m.groupId);
        const shuffle = <T>(xs: T[]) => {
          const out = [...xs];
          for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [out[i], out[j]] = [out[j]!, out[i]!];
          }
          return out;
        };
        const pairs = randomAllocation(
          {
            submissions: subs.map((s) => ({
              id: s.id,
              authorId: s.authorId,
              groups: groups(s.authorId),
            })),
            reviewers: reviewerIds.map((id) => ({ id, groups: groups(id) })),
            existing,
          },
          {
            count: input.count,
            per: input.per,
            excludeSameGroup: input.excludeSameGroup && a.groupMode !== 'NONE',
            addSelf: input.addSelf && a.settings.selfAssessment,
            keepExisting: true,
          },
          shuffle,
        );
        if (pairs.length)
          await ctx.db.workshopAssessment.createMany({ data: pairs, skipDuplicates: true });
        const told = [...new Set(pairs.map((p) => p.reviewerId))];
        if (told.length)
          await ctx.notify.send(told, {
            type: 'workshop.allocated',
            title: { key: 'mod.workshop.notify.allocatedTitle', values: { name: a.name } },
            url: `/course/${a.courseId}/a/${a.id}`,
            courseId: a.courseId,
            contextId: a.id,
          });
        return { allocated: pairs.length };
      },
    }),
    calculateGrades: defineAction({
      summary:
        'Grades for the work from its assessments, and for assessing by comparison with the best',
      capability: 'mod.workshop:manage',
      input: z.object({ comparison: z.number().int().optional() }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        const { phase } = await workshopState(ctx.db, a.id);
        if (phase !== 'evaluation')
          throw new ModuleError('CONFLICT', msg('mod.workshop.errors.evaluationPhaseOnly'));
        const comparison =
          input.comparison && (comparisons as readonly number[]).includes(input.comparison)
            ? input.comparison
            : a.settings.comparison;
        await calculateGrades(ctx, a, comparison);
        return { ok: true };
      },
    }),
    gradeSubmission: defineAction({
      summary:
        'The teacher’s grade for a submission (0..100 % of the grade, null to use the calculated one), feedback and publishing',
      capability: 'mod.workshop:manage',
      input: z.object({
        submissionId: z.string().uuid(),
        gradeOver: z.number().min(0).max(100).nullable(),
        feedback: z.string().max(100_000).default(''),
        published: z.boolean().default(false),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        const sub = await submissionOf(ctx, a, input.submissionId);
        await ctx.db.workshopSubmission.update({
          where: { id: sub.id },
          data: {
            gradeOver: input.gradeOver,
            feedback: input.feedback.trim() ? sanitizeRichText(input.feedback) : '',
            published: input.published,
          },
        });
        await pushGrades(ctx, a, [sub.authorId]);
        return { ok: true };
      },
    }),
    gradeAssessment: defineAction({
      summary:
        'Weigh an assessment (0..16), give its grade for assessing (0..100 %, null for the calculated one) and a comment to the reviewer',
      capability: 'mod.workshop:manage',
      input: z.object({
        assessmentId: z.string().uuid(),
        weight: z.number().int().min(0).max(16),
        gradingGradeOver: z.number().min(0).max(100).nullable(),
        feedbackReviewer: z.string().max(10_000).default(''),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        const x = await assessmentOf(ctx, a, input.assessmentId);
        await ctx.db.workshopAssessment.update({
          where: { id: x.id },
          data: {
            weight: input.weight,
            gradingGradeOver: input.gradingGradeOver,
            feedbackReviewer: input.feedbackReviewer.trim(),
          },
        });
        await pushGrades(ctx, a, [x.reviewerId]);
        return { ok: true };
      },
    }),
    // ── learners ──
    submit: defineAction({
      summary: 'Hand in your work, or change it while submissions are open',
      capability: 'mod.workshop:submit',
      input: z.object({
        title: z.string().trim().min(1).max(255),
        content: z.string().max(500_000).default(''),
        files: z.array(FileInput).max(20).default([]),
        removeFiles: z.array(z.string().uuid()).max(50).default([]),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        const s = a.settings;
        const user = me(ctx);
        const { phase } = await workshopState(ctx.db, a.id);
        const existing = await ctx.db.workshopSubmission.findUnique({
          where: { activityId_authorId: { activityId: a.id, authorId: user } },
        });
        const open = phase === 'submission' && within(ctx.now, s.submissionStart, s.submissionEnd);
        const late =
          s.lateSubmissions &&
          !existing &&
          (phase === 'submission' || phase === 'assessment') &&
          !!s.submissionEnd &&
          ctx.now > new Date(s.submissionEnd);
        if (!open && !late)
          throw new ModuleError('CONFLICT', msg('mod.workshop.errors.submissionsClosed'));
        const content = input.content.trim() ? sanitizeRichText(input.content) : '';
        const hasText = !!content && !isEmptyRichText(content);
        if (s.submissionText === 'required' && !hasText)
          throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.writeText'));
        const sub = existing
          ? await ctx.db.workshopSubmission.update({
              where: { id: existing.id },
              data: { title: input.title, content: s.submissionText === 'off' ? '' : content },
            })
          : await ctx.db.workshopSubmission.create({
              data: {
                activityId: a.id,
                authorId: user,
                title: input.title,
                content: s.submissionText === 'off' ? '' : content,
                late,
                createdAt: ctx.now,
              },
            });
        if (input.removeFiles.length)
          await ctx.files.remove(a.id, 'submission', input.removeFiles, sub.id);
        if (input.files.length) {
          if (s.submissionFiles === 'off')
            throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.noFiles'));
          const have = (await ctx.files.list(a.id, 'submission', sub.id)).length;
          if (have + input.files.length > s.maxAttachments)
            throw new ModuleError(
              'BAD_REQUEST',
              msg('mod.workshop.errors.tooManyFiles', { n: s.maxAttachments }),
            );
          for (const f of input.files)
            await ctx.files.store(
              a.id,
              'submission',
              { ...f, itemId: sub.id },
              { maxBytes: s.maxFileMB * 1024 * 1024 },
            );
        }
        if (
          s.submissionFiles === 'required' &&
          !(await ctx.files.list(a.id, 'submission', sub.id)).length
        )
          throw new ModuleError('BAD_REQUEST', msg('mod.workshop.errors.attachFile'));
        await ctx.completion.recompute(a.id, user);
        return { id: sub.id };
      },
    }),
    assess: defineAction({
      summary:
        'Fill in the assessment form for a submission you were allocated (teachers may assess any submission by its id)',
      input: z.object({
        assessmentId: z.string().uuid().optional(),
        submissionId: z.string().uuid().optional(),
        filling: z.record(
          z.string(),
          z.object({
            grade: z.number().optional(),
            levelId: z.string().max(64).optional(),
            passed: z.boolean().optional(),
            comment: z.string().max(10_000).optional(),
          }),
        ),
        feedbackAuthor: z.string().max(100_000).default(''),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Ws;
        const s = a.settings;
        const user = me(ctx);
        const r = await rights(ctx, a);
        const { phase } = await workshopState(ctx.db, a.id);
        let x = input.assessmentId ? await assessmentOf(ctx, a, input.assessmentId) : null;
        if (!x && input.submissionId && r.manage) {
          const sub = await submissionOf(ctx, a, input.submissionId);
          const row = await ctx.db.workshopAssessment.upsert({
            where: { submissionId_reviewerId: { submissionId: sub.id, reviewerId: user } },
            create: { submissionId: sub.id, reviewerId: user },
            update: {},
          });
          x = { ...row, submission: sub };
        }
        if (!x) throw new ModuleError('NOT_FOUND', msg('mod.workshop.errors.noAssessment'));
        if (x.reviewerId !== user)
          throw new ModuleError('FORBIDDEN', msg('mod.workshop.errors.othersAssessment'));
        if (!r.manage) {
          if (!r.assess)
            throw new ModuleError('FORBIDDEN', msg('mod.workshop.errors.notAssessing'));
          if (phase !== 'assessment' || !within(ctx.now, s.assessmentStart, s.assessmentEnd))
            throw new ModuleError('CONFLICT', msg('mod.workshop.errors.assessmentClosed'));
        }
        const form = await formOf(ctx.db, a);
        const filling = Object.fromEntries(
          form.dimensions.map((d) => {
            const v = input.filling[d.id] ?? {};
            return [d.id, { ...v, comment: v.comment?.trim() ? v.comment.trim() : undefined }];
          }),
        ) as Filling;
        const err = fillingError(form, filling);
        if (err) throw new ModuleError('BAD_REQUEST', err);
        await ctx.db.workshopAssessment.update({
          where: { id: x.id },
          data: {
            filling: filling as Prisma.InputJsonValue,
            grade: assessmentGrade(form, filling),
            feedbackAuthor: input.feedbackAuthor.trim()
              ? sanitizeRichText(input.feedbackAuthor)
              : '',
            assessedAt: ctx.now,
          },
        });
        await ctx.completion.recompute(a.id, user);
        return { id: x.id };
      },
    }),
  },
});

export type { Dimension, Filling, Phase, Strategy, SubmissionRow, WorkshopForm };
export const workshopModules = [workshop];
