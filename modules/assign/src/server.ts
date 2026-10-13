import type { Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { type ActivityRef, defineAction, defineModule, type ModuleCtx } from '@hubium/module-sdk';
import { bool, isoDate, optionalNumber } from '@hubium/module-sdk/fields';
import { z } from 'zod';

// mod-assign: text and/or file submissions, grading with feedback, extensions, reopening.

export const AssignSettings = z
  .object({
    allowText: bool(true),
    allowFiles: bool(true),
    maxFiles: z.coerce.number().int().min(1).max(20).default(5),
    maxFileMB: z.coerce.number().int().min(1).max(500).default(20),
    wordLimit: z.coerce.number().int().min(0).max(100_000).default(0),
    openAt: isoDate,
    dueAt: isoDate,
    cutoffAt: isoDate,
    gradeMax: z.coerce.number().min(1).max(10_000).default(100),
    gradePass: optionalNumber(0, 10_000),
    /** Grade on this scale instead of points (grades are its 1-based positions). */
    scaleId: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).default(null),
    submitButton: bool(true),
    reopen: z.enum(['none', 'manual', 'untilpass']).default('none'),
    maxAttempts: z.coerce.number().int().min(0).max(100).default(0),
  })
  .refine((s) => s.allowText || s.allowFiles, {
    message: 'Allow text or files',
    path: ['allowText'],
  })
  .refine((s) => !s.dueAt || !s.openAt || s.dueAt > s.openAt, {
    message: 'Due date must be after the opening date',
    path: ['dueAt'],
  })
  .refine((s) => !s.cutoffAt || !s.dueAt || s.cutoffAt >= s.dueAt, {
    message: 'Cut-off must not be before the due date',
    path: ['cutoffAt'],
  })
  .refine((s) => s.gradePass === undefined || s.gradePass <= s.gradeMax, {
    message: 'Pass grade exceeds maximum',
    path: ['gradePass'],
  });

export type AssignSettingsT = z.output<typeof AssignSettings>;

export interface EffectiveDates {
  openAt: Date | null;
  dueAt: Date | null;
  cutoffAt: Date | null;
  extended: boolean;
}

/** Activity dates with a per-user extension applied. */
export async function effectiveDates(
  db: Prisma.TransactionClient,
  a: ActivityRef<AssignSettingsT>,
  userId: string,
): Promise<EffectiveDates> {
  const o = await db.assignOverride.findUnique({
    where: { activityId_userId: { activityId: a.id, userId } },
  });
  const d = (v: string | null | undefined) => (v ? new Date(v) : null);
  const dueAt = o?.dueAt ?? d(a.settings.dueAt);
  let cutoffAt = o?.cutoffAt ?? d(a.settings.cutoffAt);
  // An extension past the course-wide cut-off moves the cut-off with it.
  if (o?.dueAt && !o.cutoffAt && cutoffAt && cutoffAt < o.dueAt) cutoffAt = o.dueAt;
  return {
    openAt: o?.allowSubmissionsFrom ?? d(a.settings.openAt),
    dueAt,
    cutoffAt,
    extended: !!o,
  };
}

export function canSubmitNow(
  dates: EffectiveDates,
  now: Date,
): { ok: boolean; reason?: 'notOpen' | 'closed' } {
  if (dates.openAt && now < dates.openAt) return { ok: false, reason: 'notOpen' };
  if (dates.cutoffAt && now >= dates.cutoffAt) return { ok: false, reason: 'closed' };
  return { ok: true };
}

export function countWords(html: string): number {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

async function latestSubmission(db: Prisma.TransactionClient, activityId: string, userId: string) {
  return db.assignSubmission.findFirst({ where: { activityId, userId, latest: true } });
}

const FileInput = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().default('application/octet-stream'),
  data: z.instanceof(Buffer),
});

function userId(ctx: ModuleCtx): string {
  if (ctx.actor.kind !== 'user') throw new Error('Sign in required');
  return ctx.actor.userId;
}

/** The grades of the assignment's scale, worst first; null when graded by points. */
export async function assignScale(
  db: Prisma.TransactionClient,
  a: ActivityRef<AssignSettingsT>,
): Promise<string[] | null> {
  if (!a.settings.scaleId) return null;
  const s = await db.scale.findFirst({
    where: { id: a.settings.scaleId, OR: [{ courseId: null }, { courseId: a.courseId }] },
    select: { items: true },
  });
  return s?.items ?? null;
}

/** A grade as people read it: the scale's grade, or points out of the maximum. */
export function assignGradeText(
  grade: number,
  scale: string[] | null,
  gradeMax: number,
  outOf: (max: number) => string,
): string {
  return scale ? (scale[Math.round(grade) - 1] ?? '—') : `${grade} ${outOf(gradeMax)}`;
}

export const assign = defineModule<AssignSettingsT>({
  key: 'assign',
  archetype: 'activity',
  icon: 'ClipboardCheck',
  supports: { grading: true, groups: true, viewCompletion: true, backup: true },
  privacy: {
    async export(ctx, userId) {
      const [submissions, grades] = await Promise.all([
        ctx.db.assignSubmission.findMany({
          where: { userId },
          select: {
            activityId: true,
            attemptNumber: true,
            status: true,
            onlineText: true,
            submittedAt: true,
          },
        }),
        ctx.db.assignGrade.findMany({
          where: { userId },
          select: {
            activityId: true,
            attemptNumber: true,
            grade: true,
            feedback: true,
            gradedAt: true,
          },
        }),
      ]);
      return { submissions, grades };
    },
    async erase(ctx, userId) {
      const subs = await ctx.db.assignSubmission.findMany({
        where: { userId },
        select: { id: true, activityId: true },
      });
      for (const s of subs) {
        const files = await ctx.files.list(s.activityId, 'submission', s.id);
        if (files.length)
          await ctx.files.remove(
            s.activityId,
            'submission',
            files.map((f) => f.id),
          );
      }
      await ctx.db.assignSubmission.updateMany({ where: { userId }, data: { onlineText: '' } });
    },
  },
  backup: { userFileAreas: ['submission', 'feedback'] },
  notifications: {
    submitted: { email: 'DIGEST' },
    graded: { email: 'IMMEDIATE' },
    due: { email: 'IMMEDIATE' },
  },
  settings: {
    schema: AssignSettings as unknown as z.ZodType<AssignSettingsT>,
    defaults: () => AssignSettings.parse({}),
  },
  grading: {
    items: (a) => [
      {
        itemNumber: 0,
        name: '',
        gradeMax: a.settings.gradeMax,
        gradePass: a.settings.gradePass,
        scaleId: a.settings.scaleId,
      },
    ],
  },
  calendar: {
    events: (a) => [
      ...(a.settings.openAt
        ? [{ kind: 'OPEN' as const, title: a.name, startsAt: new Date(a.settings.openAt) }]
        : []),
      ...(a.settings.dueAt
        ? [{ kind: 'DUE' as const, title: a.name, startsAt: new Date(a.settings.dueAt) }]
        : []),
      ...(a.settings.cutoffAt
        ? [{ kind: 'CUTOFF' as const, title: a.name, startsAt: new Date(a.settings.cutoffAt) }]
        : []),
    ],
  },
  completion: {
    schema: z.object({ submit: bool(false), grade: bool(false), pass: bool(false) }),
    async evaluate(ctx, a, uid, rules) {
      const sub = await latestSubmission(ctx.db, a.id, uid);
      if (rules.submit && sub?.status !== 'SUBMITTED') return 'incomplete';
      if (rules.grade || rules.pass) {
        const item = await ctx.db.gradeItem.findFirst({
          where: { activityId: a.id, itemNumber: 0 },
        });
        const g = item
          ? await ctx.db.grade.findUnique({
              where: { gradeItemId_userId: { gradeItemId: item.id, userId: uid } },
            })
          : null;
        if (!g?.finalGrade) return 'incomplete';
        if (rules.pass && item?.gradePass !== null && item?.gradePass !== undefined) {
          return Number(g.finalGrade) >= Number(item.gradePass) ? 'pass' : 'fail';
        }
      }
      return 'complete';
    },
  },
  files: {
    // Submissions and feedback: the owner and anyone who grades (non-editing teachers too).
    submission: {
      canRead: async (ctx, a, f) =>
        ctx.actor.kind === 'user' &&
        (f.uploadedById === ctx.actor.userId || (await ctx.perm.can('mod.assign:grade', a.id))),
    },
    feedback: {
      canRead: async (ctx, a, f) =>
        ctx.actor.kind === 'user' &&
        (f.itemId === ctx.actor.userId || (await ctx.perm.can('mod.assign:grade', a.id))),
    },
  },
  cron: [
    {
      name: 'assign.due.reminder',
      schedule: '5 * * * *',
      async handler(ctx) {
        // Students who have not submitted get a reminder 24-25 hours before the due date.
        const from = new Date(ctx.now.getTime() + 24 * 3600_000);
        const to = new Date(from.getTime() + 3600_000);
        const events = await ctx.db.calendarEvent.findMany({
          where: { moduleKey: 'assign', kind: 'DUE', startsAt: { gte: from, lt: to } },
          select: { activityId: true, courseId: true, title: true },
        });
        let sent = 0;
        for (const e of events) {
          if (!e.activityId || !e.courseId) continue;
          const act = await ctx.db.activity.findUnique({
            where: { id: e.activityId },
            select: { visibility: true, deletedAt: true },
          });
          if (!act || act.deletedAt || act.visibility !== 'SHOWN') continue;
          const students = await ctx.perm.usersWithCap('mod.assign:submit', e.activityId);
          const done = await ctx.db.assignSubmission.findMany({
            where: { activityId: e.activityId, latest: true, status: 'SUBMITTED' },
            select: { userId: true },
          });
          const extended = await ctx.db.assignOverride.findMany({
            where: { activityId: e.activityId },
            select: { userId: true },
          });
          const skip = new Set([...done, ...extended].map((x) => x.userId));
          const users = students.filter((u) => !skip.has(u));
          await ctx.notify.send(users, {
            type: 'assign.due',
            title: { key: 'mod.assign.notify.dueTitle', values: { name: e.title } },
            url: `/course/${e.courseId}/a/${e.activityId}`,
            courseId: e.courseId,
            contextId: e.activityId,
          });
          sent += users.length;
        }
        return { sent };
      },
    },
  ],
  actions: {
    saveSubmission: defineAction({
      capability: 'mod.assign:submit',
      input: z.object({
        text: z.string().max(500_000).default(''),
        files: z.array(FileInput).max(20).default([]),
        removeFiles: z.array(z.string()).default([]),
        submit: z.boolean().default(false),
      }),
      async handler(ctx, a, input) {
        const uid = userId(ctx);
        const s = a.settings as AssignSettingsT;
        const dates = await effectiveDates(ctx.db, a as ActivityRef<AssignSettingsT>, uid);
        const window = canSubmitNow(dates, ctx.now);
        if (!window.ok)
          throw new Error(
            window.reason === 'notOpen' ? 'Submissions are not open yet' : 'Submissions are closed',
          );
        let sub = await latestSubmission(ctx.db, a.id, uid);
        if (sub?.status === 'SUBMITTED') throw new Error('Already submitted');
        const text = s.allowText ? sanitizeRichText(input.text) : '';
        if (s.wordLimit && countWords(text) > s.wordLimit)
          throw new Error(`Word limit is ${s.wordLimit}`);
        sub ??= await ctx.db.assignSubmission.create({
          data: { activityId: a.id, userId: uid, attemptNumber: 0, status: 'NEW' },
        });
        if (s.allowFiles) {
          if (input.removeFiles.length)
            await ctx.files.remove(a.id, 'submission', input.removeFiles, sub.id);
          const existing = await ctx.files.list(a.id, 'submission', sub.id);
          if (existing.length + input.files.length > s.maxFiles)
            throw new Error(`At most ${s.maxFiles} files`);
          for (const f of input.files) {
            await ctx.files.store(
              a.id,
              'submission',
              { ...f, itemId: sub.id },
              { maxBytes: s.maxFileMB * 1024 * 1024 },
            );
          }
        }
        const files = s.allowFiles ? await ctx.files.list(a.id, 'submission', sub.id) : [];
        const submitting = input.submit || !s.submitButton;
        if (submitting && !text.replace(/<[^>]*>/g, '').trim() && files.length === 0)
          throw new Error('The submission is empty');
        sub = await ctx.db.assignSubmission.update({
          where: { id: sub.id },
          data: {
            onlineText: text,
            status: submitting ? 'SUBMITTED' : 'DRAFT',
            submittedAt: submitting ? ctx.now : null,
          },
        });
        await ctx.log('assign.submission.saved', { activityId: a.id, status: sub.status });
        if (submitting) {
          await ctx.completion.recompute(a.id, uid);
          const graders = await ctx.perm.usersWithCap('mod.assign:grade', a.id);
          const me = await ctx.db.user.findUniqueOrThrow({
            where: { id: uid },
            select: { name: true },
          });
          await ctx.notify.send(graders, {
            type: 'assign.submitted',
            title: {
              key: 'mod.assign.notify.submittedTitle',
              values: { name: a.name, user: me.name },
            },
            url: `/course/${a.courseId}/a/${a.id}?grade=${uid}`,
            courseId: a.courseId,
            contextId: a.id,
          });
        }
        return { status: sub.status };
      },
    }),
    revertToDraft: defineAction({
      capability: 'mod.assign:submit',
      input: z.object({}),
      async handler(ctx, a) {
        const uid = userId(ctx);
        const sub = await latestSubmission(ctx.db, a.id, uid);
        if (sub?.status !== 'SUBMITTED') throw new Error('Nothing to withdraw');
        const graded = await ctx.db.assignGrade.findUnique({
          where: {
            activityId_userId_attemptNumber: {
              activityId: a.id,
              userId: uid,
              attemptNumber: sub.attemptNumber,
            },
          },
        });
        if (graded) throw new Error('Already graded');
        const dates = await effectiveDates(ctx.db, a as ActivityRef<AssignSettingsT>, uid);
        if (!canSubmitNow(dates, ctx.now).ok) throw new Error('Submissions are closed');
        await ctx.db.assignSubmission.update({
          where: { id: sub.id },
          data: { status: 'DRAFT', submittedAt: null },
        });
        await ctx.completion.recompute(a.id, uid);
        return { ok: true };
      },
    }),
    grade: defineAction({
      capability: 'mod.assign:grade',
      input: z.object({
        userId: z.string().uuid(),
        grade: z.union([z.number(), z.null()]),
        feedback: z.string().max(200_000).default(''),
        files: z.array(FileInput).max(20).default([]),
        reopen: z.boolean().default(false),
      }),
      async handler(ctx, a, input) {
        const s = a.settings as AssignSettingsT;
        const scale = await assignScale(ctx.db, a as ActivityRef<AssignSettingsT>);
        if (input.grade !== null) {
          if (scale) {
            if (!Number.isInteger(input.grade) || input.grade < 1 || input.grade > scale.length)
              throw new Error('Choose a grade of the scale');
          } else if (input.grade < 0 || input.grade > s.gradeMax)
            throw new Error(`Grade must be between 0 and ${s.gradeMax}`);
        }
        const enrolled = await ctx.db.enrolment.findFirst({
          where: { courseId: a.courseId, userId: input.userId },
        });
        if (!enrolled) throw new Error('User is not enrolled');
        const sub = await latestSubmission(ctx.db, a.id, input.userId);
        const attemptNumber = sub?.attemptNumber ?? 0;
        const feedback = sanitizeRichText(input.feedback);
        const graderId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
        await ctx.db.assignGrade.upsert({
          where: {
            activityId_userId_attemptNumber: {
              activityId: a.id,
              userId: input.userId,
              attemptNumber,
            },
          },
          create: {
            activityId: a.id,
            userId: input.userId,
            attemptNumber,
            grade: input.grade,
            feedback,
            graderId,
          },
          update: { grade: input.grade, feedback, graderId, gradedAt: ctx.now },
        });
        for (const f of input.files) {
          await ctx.files.store(
            a.id,
            'feedback',
            { ...f, itemId: input.userId, path: `/${attemptNumber}/` },
            { maxBytes: 50 * 1024 * 1024 },
          );
        }
        await ctx.grades.setGrades(a.id, [
          { userId: input.userId, rawGrade: input.grade, feedback, gradedById: graderId },
        ]);
        await ctx.completion.recompute(a.id, input.userId);
        const failed =
          s.gradePass !== undefined && input.grade !== null && input.grade < s.gradePass;
        const allowMore = !s.maxAttempts || attemptNumber + 1 < s.maxAttempts;
        if (sub && allowMore && (input.reopen || (s.reopen === 'untilpass' && failed))) {
          await ctx.db.assignSubmission.update({ where: { id: sub.id }, data: { latest: false } });
          await ctx.db.assignSubmission.create({
            data: {
              activityId: a.id,
              userId: input.userId,
              attemptNumber: attemptNumber + 1,
              status: 'REOPENED',
              onlineText: sub.onlineText,
            },
          });
        }
        await ctx.notify.send([input.userId], {
          type: 'assign.graded',
          title: { key: 'mod.assign.notify.gradedTitle', values: { name: a.name } },
          url: `/course/${a.courseId}/a/${a.id}`,
          courseId: a.courseId,
          contextId: a.id,
        });
        await ctx.log('assign.graded', {
          activityId: a.id,
          userId: input.userId,
          grade: input.grade,
        });
        return { ok: true };
      },
    }),
    // AI grading assistant: a suggestion only; the teacher copies it into the form.
    aiConsent: defineAction({
      capability: 'mod.assign:grade',
      mutation: false,
      input: z.object({}),
      async handler(ctx) {
        await ctx.ai.acceptConsent('GRADING_ASSIST');
        return { ok: true };
      },
    }),
    aiSuggest: defineAction({
      capability: 'mod.assign:grade',
      mutation: false,
      input: z.object({ userId: z.string().uuid(), criteria: z.string().max(5000).default('') }),
      async handler(ctx, a, input) {
        const sub = await latestSubmission(ctx.db, a.id, input.userId);
        if (!sub) throw new Error('No submission');
        return ctx.ai.suggestGrade({ submissionId: sub.id, criteria: input.criteria });
      },
    }),
    aiMark: defineAction({
      capability: 'mod.assign:grade',
      mutation: false,
      input: z.object({ id: z.string().uuid(), status: z.enum(['APPLIED', 'DISCARDED']) }),
      async handler(ctx, _a, input) {
        await ctx.ai.markSuggestion(input.id, input.status);
        return { ok: true };
      },
    }),
    extend: defineAction({
      capability: 'mod.assign:grantextension',
      input: z.object({
        userId: z.string().uuid(),
        dueAt: z.string().nullable(),
        cutoffAt: z.string().nullable().optional(),
      }),
      async handler(ctx, a, input) {
        if (!input.dueAt) {
          await ctx.db.assignOverride.deleteMany({
            where: { activityId: a.id, userId: input.userId },
          });
          return { ok: true };
        }
        const dueAt = new Date(input.dueAt);
        const cutoffAt = input.cutoffAt ? new Date(input.cutoffAt) : dueAt;
        await ctx.db.assignOverride.upsert({
          where: { activityId_userId: { activityId: a.id, userId: input.userId } },
          create: { activityId: a.id, userId: input.userId, dueAt, cutoffAt },
          update: { dueAt, cutoffAt },
        });
        await ctx.log('assign.extension', {
          activityId: a.id,
          userId: input.userId,
          dueAt: input.dueAt,
        });
        return { ok: true };
      },
    }),
  },
  async todo(ctx, uid, courseIds) {
    const acts = await ctx.db.activity.findMany({
      where: {
        moduleKey: 'assign',
        courseId: { in: courseIds },
        deletedAt: null,
        visibility: 'SHOWN',
      },
    });
    const out = [];
    for (const a of acts) {
      const settings = AssignSettings.safeParse(a.settings);
      if (!settings.success) continue;
      const canGrade = await ctx.perm.can('mod.assign:grade', a.id);
      if (canGrade) {
        const pending = await ctx.db.assignSubmission.count({
          where: {
            activityId: a.id,
            latest: true,
            status: 'SUBMITTED',
            user: { assignGrades: { none: { activityId: a.id } } },
          },
        });
        if (pending)
          out.push({
            activityId: a.id,
            courseId: a.courseId,
            title: a.name,
            kind: 'grade' as const,
            count: pending,
          });
        continue;
      }
      if (!(await ctx.perm.can('mod.assign:submit', a.id))) continue;
      const sub = await latestSubmission(ctx.db, a.id, uid);
      if (sub?.status === 'SUBMITTED') continue;
      const due = settings.data.dueAt ? new Date(settings.data.dueAt) : null;
      if (due && due.getTime() < ctx.now.getTime() - 7 * 86_400_000) continue;
      out.push({
        activityId: a.id,
        courseId: a.courseId,
        title: a.name,
        kind: 'submit' as const,
        dueAt: due,
      });
    }
    return out;
  },
});

export const assignModules = [assign];
