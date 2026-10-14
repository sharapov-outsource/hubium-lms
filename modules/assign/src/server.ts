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
import { bool } from '@hubium/module-sdk/fields';
import { z } from 'zod';
import { AssignSettings, type AssignSettingsT } from './config.ts';
import { type EffectiveDates, effectiveDates } from './dates.ts';
import { applyPenalty, latePenalty, lateSeconds } from './penalty.ts';
import { pushGrades } from './push.ts';
import { ownerOf, type Team, teamOf } from './team.ts';

// mod-assign: text and/or file submissions, alone or as a team, grading with feedback and
// a late penalty, date overrides for students and groups, reopening.

export { AssignSettings, type AssignSettingsT } from './config.ts';
export { type EffectiveDates, effectiveDates } from './dates.ts';
export { applyPenalty, latePenalty } from './penalty.ts';
export { type Team, teamOf } from './team.ts';

type Assign = ActivityRef<AssignSettingsT>;
type Db = Prisma.TransactionClient;

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

/** A student's latest submission: their own, or their team's (none while they are blocked). */
export async function latestFor(db: Db, a: Assign, userId: string, team?: Team) {
  const t = team ?? (await teamOf(db, a, userId));
  if (t.kind === 'blocked') return null;
  return db.assignSubmission.findFirst({
    where: { activityId: a.id, latest: true, ...ownerOf(userId, t) },
  });
}

/** The members of a team who submit to the assignment. */
export async function teamMembers(ctx: ModuleCtx, a: Assign, groupId: string) {
  const [learners, members] = await Promise.all([
    ctx.perm.usersWithCap('mod.assign:submit', a.id),
    ctx.db.groupMember.findMany({ where: { groupId }, select: { userId: true } }),
  ]);
  const ids = new Set(learners);
  return ctx.db.user.findMany({
    where: {
      id: { in: members.map((m) => m.userId).filter((id) => ids.has(id)) },
      deletedAt: null,
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: { id: true, name: true },
  });
}

/** Everyone whose grade follows a submission: its student, or the members of its team. */
async function ownersOf(ctx: ModuleCtx, a: Assign, userId: string, team: Team) {
  return team.kind === 'team'
    ? (await teamMembers(ctx, a, team.groupId)).map((m) => m.id)
    : [userId];
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
export async function assignScale(db: Db, a: Assign): Promise<string[] | null> {
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

const blockedMessage = (reason: 'noGroup' | 'severalGroups') =>
  reason === 'noGroup'
    ? 'This assignment is submitted by teams: you are in no group yet'
    : 'You are in several teams for this assignment: ask your teacher to keep one';

// ── reading (the assignment page and the API query share this) ─────────────────

/**
 * The user's own assignment: dates with their override, their team, whether they may
 * submit now, the latest submission with its files, how late it is and the penalty that
 * follows, and the latest grade with feedback (the grade of an earlier attempt stays
 * visible while a new one is open).
 */
export async function readAssignStatus(ctx: ModuleCtx, a: Assign) {
  const me = userId(ctx);
  const s = a.settings;
  const [scale, canSubmit, team, dates] = await Promise.all([
    assignScale(ctx.db, a),
    ctx.perm.can('mod.assign:submit', a.id),
    teamOf(ctx.db, a, me),
    effectiveDates(ctx.db, a, me),
  ]);
  const sub = await latestFor(ctx.db, a, me, team);
  const files = sub ? await ctx.files.list(a.id, 'submission', sub.id) : [];
  const current = sub
    ? await ctx.db.assignGrade.findUnique({
        where: {
          activityId_userId_attemptNumber: {
            activityId: a.id,
            userId: me,
            attemptNumber: sub.attemptNumber,
          },
        },
      })
    : null;
  const last =
    current ??
    (await ctx.db.assignGrade.findFirst({
      where: { activityId: a.id, userId: me },
      orderBy: { attemptNumber: 'desc' },
    }));
  const [grader, feedbackFiles] = last
    ? await Promise.all([
        last.graderId
          ? ctx.db.user.findUnique({ where: { id: last.graderId }, select: { name: true } })
          : null,
        ctx.files
          .list(a.id, 'feedback', me)
          .then((fs) => fs.filter((f) => f.path === `/${last.attemptNumber}/`)),
      ])
    : [null, []];
  const confirmed = sub
    ? new Set(
        (
          await ctx.db.assignTeamSubmit.findMany({
            where: { submissionId: sub.id },
            select: { userId: true },
          })
        ).map((x) => x.userId),
      )
    : new Set<string>();
  const members = team.kind === 'team' ? await teamMembers(ctx, a, team.groupId) : [];
  const window = canSubmitNow(dates, ctx.now);
  const status = sub?.status ?? 'NEW';
  const waiting = s.requireAllTeamMembers && team.kind === 'team' && confirmed.has(me);
  // late: the work as handed in, or, before it is, how late it would be now
  const late = lateSeconds(
    status === 'SUBMITTED' ? (sub?.submittedAt ?? null) : ctx.now,
    dates.dueAt,
  );
  const penalty = scale ? 0 : latePenalty(late, s.latePenaltyPerDay, s.latePenaltyCap);
  const value = last?.grade === null || last?.grade === undefined ? null : Number(last.grade);
  return {
    dates,
    canSubmit,
    window: { open: window.ok, reason: window.reason ?? null },
    team:
      team.kind === 'team'
        ? {
            name: team.name,
            members: members.map((m) => ({
              id: m.id,
              name: m.name,
              submitted: status === 'SUBMITTED' || confirmed.has(m.id),
            })),
          }
        : null,
    blocked: team.kind === 'blocked' ? team.reason : null,
    status,
    attemptNumber: sub?.attemptNumber ?? 0,
    editable:
      canSubmit && window.ok && status !== 'SUBMITTED' && team.kind !== 'blocked' && !waiting,
    /** This member has submitted and waits for the rest of the team. */
    waitingForTeam: waiting && status !== 'SUBMITTED',
    canWithdraw: status === 'SUBMITTED' && window.ok && !current,
    requireStatement: s.requireStatement,
    statementAcceptedAt: sub?.statementAcceptedAt ?? null,
    submission: sub
      ? { id: sub.id, onlineText: sub.onlineText, submittedAt: sub.submittedAt, files }
      : null,
    late: { seconds: late, penalty },
    gradeMax: s.gradeMax,
    scale,
    grade: last
      ? {
          attemptNumber: last.attemptNumber,
          value,
          penalty: last.penalty === null ? null : Number(last.penalty),
          lateSeconds: last.lateSeconds,
          /** The grade the gradebook holds: the value less the penalty. */
          final:
            value === null
              ? null
              : last.penalty === null
                ? value
                : applyPenalty(value, Number(last.penalty)),
          feedback: last.feedback,
          gradedAt: last.gradedAt,
          graderName: grader?.name ?? null,
          feedbackFiles,
        }
      : null,
  };
}

/** Grades again after dates change: the penalty follows the student's due date. */
async function regrade(ctx: ModuleCtx, a: Assign, userIds: string[]) {
  if (!userIds.length) return;
  await pushGrades(ctx, a, userIds, await assignScale(ctx.db, a));
}

/** Students a date override applies to: one student, or the members of a group. */
async function overrideUsers(ctx: ModuleCtx, o: { userId: string | null; groupId: string | null }) {
  if (o.userId) return [o.userId];
  if (!o.groupId) return [];
  const rows = await ctx.db.groupMember.findMany({
    where: { groupId: o.groupId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

const DateInput = z.string().datetime({ offset: true }).nullable().optional();

export const assign = defineModule<AssignSettingsT>({
  key: 'assign',
  archetype: 'activity',
  icon: 'ClipboardCheck',
  supports: { grading: true, groups: true, viewCompletion: true, backup: true },
  privacy: {
    async export(ctx, uid) {
      const groups = await ctx.db.groupMember.findMany({
        where: { userId: uid },
        select: { groupId: true },
      });
      const [submissions, grades] = await Promise.all([
        ctx.db.assignSubmission.findMany({
          // their own work, and their teams'
          where: {
            OR: [{ userId: uid }, { groupId: { in: groups.map((g) => g.groupId) }, userId: null }],
          },
          select: {
            activityId: true,
            attemptNumber: true,
            status: true,
            onlineText: true,
            submittedAt: true,
            groupId: true,
          },
        }),
        ctx.db.assignGrade.findMany({
          where: { userId: uid },
          select: {
            activityId: true,
            attemptNumber: true,
            grade: true,
            penalty: true,
            feedback: true,
            gradedAt: true,
          },
        }),
      ]);
      return { submissions, grades };
    },
    // A team's work belongs to the team and stays; the student's own work goes.
    async erase(ctx, uid) {
      const subs = await ctx.db.assignSubmission.findMany({
        where: { userId: uid },
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
      await ctx.db.assignSubmission.updateMany({
        where: { userId: uid },
        data: { onlineText: '' },
      });
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
      const sub = await latestFor(ctx.db, a as Assign, uid);
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
    // Submissions and feedback: the owner (a team's members for team work) and anyone who
    // grades (non-editing teachers too).
    submission: {
      canRead: async (ctx, a, f) => {
        if (ctx.actor.kind !== 'user') return false;
        if (f.uploadedById === ctx.actor.userId) return true;
        if (await ctx.perm.can('mod.assign:grade', a.id)) return true;
        if (!f.itemId) return false;
        const sub = await ctx.db.assignSubmission.findUnique({
          where: { id: f.itemId },
          select: { activityId: true, userId: true, groupId: true },
        });
        if (!sub || sub.activityId !== a.id) return false;
        if (sub.userId === ctx.actor.userId) return true;
        return (
          !!sub.groupId &&
          !!(await ctx.db.groupMember.findUnique({
            where: { groupId_userId: { groupId: sub.groupId, userId: ctx.actor.userId } },
          }))
        );
      },
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
        // Students who have not submitted get a reminder 24-25 hours before their due date
        // (the assignment's, or their override's).
        const from = new Date(ctx.now.getTime() + 24 * 3600_000);
        const to = new Date(from.getTime() + 3600_000);
        const [events, overrides] = await Promise.all([
          ctx.db.calendarEvent.findMany({
            where: { moduleKey: 'assign', kind: 'DUE', startsAt: { gte: from, lt: to } },
            select: { activityId: true },
          }),
          ctx.db.assignOverride.findMany({
            where: { dueAt: { gte: from, lt: to } },
            select: { activityId: true },
          }),
        ]);
        const ids = [
          ...new Set(
            [...events, ...overrides].flatMap((e) => (e.activityId ? [e.activityId] : [])),
          ),
        ];
        let sent = 0;
        for (const id of ids) {
          const act = await ctx.db.activity.findUnique({ where: { id } });
          if (!act || act.deletedAt || act.visibility !== 'SHOWN') continue;
          const parsed = AssignSettings.safeParse(act.settings);
          if (!parsed.success) continue;
          const a = { ...(act as unknown as Assign), settings: parsed.data };
          const users: string[] = [];
          for (const u of await ctx.perm.usersWithCap('mod.assign:submit', id)) {
            const due = (await effectiveDates(ctx.db, a, u)).dueAt;
            if (!due || due < from || due >= to) continue;
            if ((await latestFor(ctx.db, a, u))?.status === 'SUBMITTED') continue;
            users.push(u);
          }
          await ctx.notify.send(users, {
            type: 'assign.due',
            title: { key: 'mod.assign.notify.dueTitle', values: { name: act.name } },
            url: `/course/${act.courseId}/a/${id}`,
            courseId: act.courseId,
            contextId: id,
          });
          sent += users.length;
        }
        return { sent };
      },
    },
  ],
  queries: {
    status: defineQuery({
      summary:
        "The user's own submission (or their team's), dates with overrides, lateness and penalty, grade and feedback",
      input: z.object({}),
      output: z.object({
        dates: z.object({
          openAt: z.string().nullable(),
          dueAt: z.string().nullable(),
          cutoffAt: z.string().nullable(),
          extended: z.boolean(),
          source: z.enum(['user', 'group']).nullable().describe('which override set the dates'),
        }),
        canSubmit: z.boolean().describe('the user has the capability to submit'),
        window: z.object({
          open: z.boolean(),
          reason: z.enum(['notOpen', 'closed']).nullable(),
        }),
        team: z
          .object({
            name: z.string(),
            members: z.array(
              z.object({ id: z.string().uuid(), name: z.string(), submitted: z.boolean() }),
            ),
          })
          .nullable()
          .describe('team submissions: the team and who has submitted'),
        blocked: z
          .enum(['noGroup', 'severalGroups'])
          .nullable()
          .describe('team submissions: why the user cannot submit'),
        status: z.enum(['NEW', 'DRAFT', 'SUBMITTED', 'REOPENED']),
        attemptNumber: z.number(),
        editable: z.boolean().describe('saveSubmission is possible now'),
        waitingForTeam: z.boolean().describe('submitted by the user, waiting for the team'),
        canWithdraw: z.boolean().describe('revertToDraft is possible now'),
        requireStatement: z.boolean().describe('submitting takes statement: true'),
        statementAcceptedAt: z.string().nullable(),
        submission: z
          .object({
            id: z.string().uuid(),
            onlineText: z.string(),
            submittedAt: z.string().nullable(),
            files: z.array(
              z.object({ id: z.string(), name: z.string(), size: z.number(), url: z.string() }),
            ),
          })
          .nullable(),
        late: z
          .object({ seconds: z.number(), penalty: z.number().describe('percent') })
          .describe('how late the work is (or would be, submitted now) and the penalty'),
        gradeMax: z.number(),
        scale: z.array(z.string()).nullable().describe('scale grades, worst first'),
        grade: z
          .object({
            attemptNumber: z.number(),
            value: z.number().nullable().describe('points, or a 1-based scale position'),
            penalty: z.number().nullable().describe('late penalty applied, percent'),
            lateSeconds: z.number().nullable(),
            final: z.number().nullable().describe('the grade less the penalty'),
            feedback: z.string(),
            gradedAt: z.string(),
            graderName: z.string().nullable(),
            feedbackFiles: z.array(
              z.object({ id: z.string(), name: z.string(), size: z.number(), url: z.string() }),
            ),
          })
          .nullable(),
      }),
      handler: (ctx, a) => readAssignStatus(ctx, a as Assign),
    }),
  },
  actions: {
    saveSubmission: defineAction({
      summary:
        'Save your submission (or your team’s): online text and files; `submit: true` sends it for grading, `statement: true` accepts the statement of authorship',
      capability: 'mod.assign:submit',
      input: z.object({
        text: z.string().max(500_000).default(''),
        files: z.array(FileInput).max(20).default([]),
        removeFiles: z.array(z.string()).default([]),
        submit: z.boolean().default(false),
        statement: z.boolean().default(false),
      }),
      async handler(ctx, act, input) {
        const uid = userId(ctx);
        const a = act as Assign;
        const s = a.settings;
        const team = await teamOf(ctx.db, a, uid);
        if (team.kind === 'blocked') throw new ModuleError('CONFLICT', blockedMessage(team.reason));
        const dates = await effectiveDates(ctx.db, a, uid);
        const window = canSubmitNow(dates, ctx.now);
        if (!window.ok)
          throw new Error(
            window.reason === 'notOpen' ? 'Submissions are not open yet' : 'Submissions are closed',
          );
        let sub = await latestFor(ctx.db, a, uid, team);
        if (sub?.status === 'SUBMITTED') throw new Error('Already submitted');
        const text = s.allowText ? sanitizeRichText(input.text) : '';
        if (s.wordLimit && countWords(text) > s.wordLimit)
          throw new Error(`Word limit is ${s.wordLimit}`);
        const submitting = input.submit || !s.submitButton;
        if (submitting && s.requireStatement && !input.statement)
          throw new Error('Accept the statement that this is your own work');
        sub ??= await ctx.db.assignSubmission.create({
          data: { activityId: a.id, attemptNumber: 0, status: 'NEW', ...ownerOf(uid, team) },
        });
        const changed =
          text !== sub.onlineText || input.files.length > 0 || input.removeFiles.length > 0;
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
        if (submitting && !text.replace(/<[^>]*>/g, '').trim() && files.length === 0)
          throw new Error('The submission is empty');
        // A team's work goes in once every member has submitted it, when the assignment asks
        // for that; a change by one member asks the others again.
        let complete = submitting;
        if (team.kind === 'team' && s.requireAllTeamMembers) {
          if (changed)
            await ctx.db.assignTeamSubmit.deleteMany({
              where: { submissionId: sub.id, userId: { not: uid } },
            });
          if (submitting)
            await ctx.db.assignTeamSubmit.upsert({
              where: { submissionId_userId: { submissionId: sub.id, userId: uid } },
              create: { submissionId: sub.id, userId: uid, submittedAt: ctx.now },
              update: { submittedAt: ctx.now },
            });
          const members = await teamMembers(ctx, a, team.groupId);
          const done = new Set(
            (
              await ctx.db.assignTeamSubmit.findMany({
                where: { submissionId: sub.id },
                select: { userId: true },
              })
            ).map((x) => x.userId),
          );
          complete = submitting && members.every((m) => done.has(m.id));
        }
        sub = await ctx.db.assignSubmission.update({
          where: { id: sub.id },
          data: {
            onlineText: text,
            status: complete ? 'SUBMITTED' : 'DRAFT',
            submittedAt: complete ? ctx.now : null,
            ...(input.statement ? { statementAcceptedAt: ctx.now } : {}),
          },
        });
        await ctx.log('assign.submission.saved', { activityId: a.id, status: sub.status });
        if (complete) {
          for (const o of await ownersOf(ctx, a, uid, team))
            await ctx.completion.recompute(a.id, o);
          const graders = await ctx.perm.usersWithCap('mod.assign:grade', a.id);
          const me = await ctx.db.user.findUniqueOrThrow({
            where: { id: uid },
            select: { name: true },
          });
          await ctx.notify.send(graders, {
            type: 'assign.submitted',
            title: {
              key: 'mod.assign.notify.submittedTitle',
              values: { name: a.name, user: team.kind === 'team' ? team.name : me.name },
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
      summary:
        'Take your submission (or your team’s) back to a draft while it is ungraded and submissions are open',
      capability: 'mod.assign:submit',
      input: z.object({}),
      async handler(ctx, act) {
        const uid = userId(ctx);
        const a = act as Assign;
        const team = await teamOf(ctx.db, a, uid);
        const sub = await latestFor(ctx.db, a, uid, team);
        if (sub?.status !== 'SUBMITTED') throw new Error('Nothing to withdraw');
        const owners = await ownersOf(ctx, a, uid, team);
        const graded = await ctx.db.assignGrade.count({
          where: { activityId: a.id, userId: { in: owners }, attemptNumber: sub.attemptNumber },
        });
        if (graded) throw new Error('Already graded');
        const dates = await effectiveDates(ctx.db, a, uid);
        if (!canSubmitNow(dates, ctx.now).ok) throw new Error('Submissions are closed');
        await ctx.db.assignSubmission.update({
          where: { id: sub.id },
          data: { status: 'DRAFT', submittedAt: null },
        });
        await ctx.db.assignTeamSubmit.deleteMany({ where: { submissionId: sub.id } });
        for (const o of owners) await ctx.completion.recompute(a.id, o);
        return { ok: true };
      },
    }),
    grade: defineAction({
      summary:
        "Grade a student's submission: points or a 1-based scale position, feedback, feedback files; `applyToTeam` grades the whole team alike",
      capability: 'mod.assign:grade',
      input: z.object({
        userId: z.string().uuid(),
        grade: z.union([z.number(), z.null()]),
        feedback: z.string().max(200_000).default(''),
        files: z.array(FileInput).max(20).default([]),
        reopen: z.boolean().default(false),
        applyToTeam: z.boolean().default(false),
      }),
      async handler(ctx, act, input) {
        const a = act as Assign;
        const s = a.settings;
        const scale = await assignScale(ctx.db, a);
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
        const team = await teamOf(ctx.db, a, input.userId);
        const sub = await latestFor(ctx.db, a, input.userId, team);
        const attemptNumber = sub?.attemptNumber ?? 0;
        const feedback = sanitizeRichText(input.feedback);
        const graderId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
        const targets =
          input.applyToTeam && team.kind === 'team'
            ? [...new Set([input.userId, ...(await ownersOf(ctx, a, input.userId, team))])]
            : [input.userId];
        for (const target of targets) {
          await ctx.db.assignGrade.upsert({
            where: {
              activityId_userId_attemptNumber: { activityId: a.id, userId: target, attemptNumber },
            },
            create: {
              activityId: a.id,
              userId: target,
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
              { ...f, itemId: target, path: `/${attemptNumber}/` },
              { maxBytes: 50 * 1024 * 1024 },
            );
          }
        }
        // the gradebook gets the grade less the late penalty
        await pushGrades(ctx, a, targets, scale);
        const failed =
          s.gradePass !== undefined && input.grade !== null && input.grade < s.gradePass;
        const allowMore = !s.maxAttempts || attemptNumber + 1 < s.maxAttempts;
        if (sub && allowMore && (input.reopen || (s.reopen === 'untilpass' && failed))) {
          await ctx.db.assignSubmission.update({ where: { id: sub.id }, data: { latest: false } });
          await ctx.db.assignSubmission.create({
            data: {
              activityId: a.id,
              userId: sub.userId,
              groupId: sub.groupId,
              attemptNumber: attemptNumber + 1,
              status: 'REOPENED',
              onlineText: sub.onlineText,
            },
          });
        }
        await ctx.notify.send(targets, {
          type: 'assign.graded',
          title: { key: 'mod.assign.notify.gradedTitle', values: { name: a.name } },
          url: `/course/${a.courseId}/a/${a.id}`,
          courseId: a.courseId,
          contextId: a.id,
        });
        for (const target of targets)
          await ctx.log('assign.graded', {
            activityId: a.id,
            userId: target,
            grade: input.grade,
          });
        return { ok: true };
      },
    }),
    // AI grading assistant: a suggestion only; the teacher copies it into the form.
    aiConsent: defineAction({
      summary: 'Accept the AI grading assistant terms for yourself',
      capability: 'mod.assign:grade',
      mutation: false,
      input: z.object({}),
      async handler(ctx) {
        await ctx.ai.acceptConsent('GRADING_ASSIST');
        return { ok: true };
      },
    }),
    aiSuggest: defineAction({
      summary: 'Ask the AI grading assistant for a suggested grade and feedback',
      capability: 'mod.assign:grade',
      mutation: false,
      input: z.object({ userId: z.string().uuid(), criteria: z.string().max(5000).default('') }),
      async handler(ctx, a, input) {
        const sub = await latestFor(ctx.db, a as Assign, input.userId);
        if (!sub) throw new Error('No submission');
        return ctx.ai.suggestGrade({
          submissionId: sub.id,
          criteria: input.criteria,
          userId: input.userId,
        });
      },
    }),
    aiMark: defineAction({
      summary: 'Record whether an AI suggestion was applied or discarded',
      capability: 'mod.assign:grade',
      mutation: false,
      input: z.object({ id: z.string().uuid(), status: z.enum(['APPLIED', 'DISCARDED']) }),
      async handler(ctx, _a, input) {
        await ctx.ai.markSuggestion(input.id, input.status);
        return { ok: true };
      },
    }),
    extend: defineAction({
      summary: 'Give a student a personal due date and cut-off (null due date removes it)',
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
        } else {
          const dueAt = new Date(input.dueAt);
          const cutoffAt = input.cutoffAt ? new Date(input.cutoffAt) : dueAt;
          await ctx.db.assignOverride.upsert({
            where: { activityId_userId: { activityId: a.id, userId: input.userId } },
            create: { activityId: a.id, userId: input.userId, dueAt, cutoffAt },
            update: { dueAt, cutoffAt },
          });
        }
        await ctx.log('assign.extension', {
          activityId: a.id,
          userId: input.userId,
          dueAt: input.dueAt,
        });
        await regrade(ctx, a as Assign, [input.userId]);
        return { ok: true };
      },
    }),
    setOverride: defineAction({
      summary:
        'Give one student or a group their own dates: opening, due date and cut-off (null keeps the assignment’s)',
      capability: 'mod.assign:manageoverrides',
      input: z
        .object({
          userId: z.string().uuid().optional(),
          groupId: z.string().uuid().optional(),
          allowSubmissionsFrom: DateInput,
          dueAt: DateInput,
          cutoffAt: DateInput,
        })
        .refine((v) => !!v.userId !== !!v.groupId, 'Give either userId or groupId'),
      async handler(ctx, a, input) {
        const d = (v: string | null | undefined) => (v ? new Date(v) : null);
        const values = {
          allowSubmissionsFrom: d(input.allowSubmissionsFrom),
          dueAt: d(input.dueAt),
          cutoffAt: d(input.cutoffAt),
        };
        if (values.dueAt && values.cutoffAt && values.cutoffAt < values.dueAt)
          throw new Error('Cut-off must not be before the due date');
        if (input.groupId) {
          const g = await ctx.db.group.findUnique({ where: { id: input.groupId } });
          if (g?.courseId !== a.courseId) throw new ModuleError('NOT_FOUND', 'No such group');
          const last = await ctx.db.assignOverride.findFirst({
            where: { activityId: a.id, groupId: { not: null } },
            orderBy: { sortOrder: 'desc' },
          });
          await ctx.db.assignOverride.upsert({
            where: { activityId_groupId: { activityId: a.id, groupId: input.groupId } },
            create: {
              activityId: a.id,
              groupId: input.groupId,
              sortOrder: (last?.sortOrder ?? 0) + 1,
              ...values,
            },
            update: values,
          });
        } else {
          const enrolled = await ctx.db.enrolment.findFirst({
            where: { courseId: a.courseId, userId: input.userId! },
          });
          if (!enrolled) throw new ModuleError('NOT_FOUND', 'User is not enrolled');
          await ctx.db.assignOverride.upsert({
            where: { activityId_userId: { activityId: a.id, userId: input.userId! } },
            create: { activityId: a.id, userId: input.userId!, ...values },
            update: values,
          });
        }
        await ctx.log('assign.override', {
          activityId: a.id,
          userId: input.userId ?? null,
          groupId: input.groupId ?? null,
        });
        await regrade(
          ctx,
          a as Assign,
          await overrideUsers(ctx, {
            userId: input.userId ?? null,
            groupId: input.groupId ?? null,
          }),
        );
        return { ok: true };
      },
    }),
    deleteOverride: defineAction({
      summary: 'Remove a student’s or a group’s dates',
      capability: 'mod.assign:manageoverrides',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, { id }) {
        const o = await ctx.db.assignOverride.findUnique({ where: { id } });
        if (o?.activityId !== a.id) throw new ModuleError('NOT_FOUND', 'No such override');
        await ctx.db.assignOverride.delete({ where: { id } });
        await regrade(ctx, a as Assign, await overrideUsers(ctx, o));
        return { ok: true };
      },
    }),
    moveOverride: defineAction({
      summary: 'Raise or lower a group’s dates: for a student in several groups the highest wins',
      capability: 'mod.assign:manageoverrides',
      input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
      async handler(ctx, a, { id, direction }) {
        const list = await ctx.db.assignOverride.findMany({
          where: { activityId: a.id, groupId: { not: null } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        const i = list.findIndex((o) => o.id === id);
        if (i < 0) throw new ModuleError('NOT_FOUND', 'No such group override');
        const j = direction === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return { ok: true };
        const order = list.map((o) => o.id);
        [order[i], order[j]] = [order[j]!, order[i]!];
        for (const [k, oid] of order.entries())
          await ctx.db.assignOverride.update({ where: { id: oid }, data: { sortOrder: k + 1 } });
        const affected = [
          ...(await overrideUsers(ctx, list[i]!)),
          ...(await overrideUsers(ctx, list[j]!)),
        ];
        await regrade(ctx, a as Assign, [...new Set(affected)]);
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
    for (const act of acts) {
      const settings = AssignSettings.safeParse(act.settings);
      if (!settings.success) continue;
      const a = { ...(act as unknown as Assign), settings: settings.data };
      const canGrade = await ctx.perm.can('mod.assign:grade', a.id);
      if (canGrade) {
        // a submission waits until its student (or a member of its team) has a grade for it
        const waiting = await ctx.db.assignSubmission.findMany({
          where: { activityId: a.id, latest: true, status: 'SUBMITTED' },
          select: { userId: true, groupId: true, attemptNumber: true },
        });
        let pending = 0;
        for (const w of waiting) {
          const owners = w.userId
            ? [w.userId]
            : w.groupId
              ? (
                  await ctx.db.groupMember.findMany({
                    where: { groupId: w.groupId },
                    select: { userId: true },
                  })
                ).map((m) => m.userId)
              : [];
          const graded = await ctx.db.assignGrade.count({
            where: { activityId: a.id, attemptNumber: w.attemptNumber, userId: { in: owners } },
          });
          if (!graded && owners.length) pending++;
        }
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
      const sub = await latestFor(ctx.db, a, uid);
      if (sub?.status === 'SUBMITTED') continue;
      const due = (await effectiveDates(ctx.db, a, uid)).dueAt;
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
