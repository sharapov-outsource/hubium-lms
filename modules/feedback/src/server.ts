import {
  type ActivityRef,
  defineAction,
  defineModule,
  defineQuery,
  type ModuleCtx,
  ModuleError,
  msg,
} from '@hubium/module-sdk';
import { csvFile } from '@hubium/module-sdk/csv';
import { bool, isoDate } from '@hubium/module-sdk/fields';
import { type Cell, writeXlsx } from '@hubium/module-sdk/xlsx';
import { z } from 'zod';
import { checkAnswers } from './answers.ts';
import {
  ANSWERED,
  type Answer,
  ITEM_TYPES,
  type Item,
  type ItemType,
  itemNumbers,
} from './items.ts';

export * from './answers.ts';
export * from './items.ts';

// mod-feedback: a survey of the teacher's own questions, as Moodle's feedback. Items are
// rows in order (info texts, short and long text, choices, numbers and page breaks);
// a response keeps its answers as JSON. Anonymous responses never show whose they are.

export const FeedbackSettings = z
  .object({
    anonymous: bool(true),
    /** A learner may answer more than once. */
    multipleSubmit: bool(false),
    /** Learners see the summary (choices and numbers) after answering. */
    showAnalysis: bool(false),
    /** People who see the responses are told of each new one. */
    notifyTeachers: bool(false),
    autoNumbering: bool(true),
    opensAt: isoDate,
    closesAt: isoDate,
    /** Shown after the answers are sent. */
    thankYou: z.string().trim().max(2000).default(''),
  })
  .refine((s) => !s.opensAt || !s.closesAt || s.closesAt > s.opensAt, {
    message: 'errors.common.afterOpening',
    path: ['closesAt'],
  });
export type FeedbackSettingsT = z.output<typeof FeedbackSettings>;
type Feedback = ActivityRef<FeedbackSettingsT>;

export const ItemInput = z
  .object({
    type: z.enum(ITEM_TYPES),
    label: z.string().trim().max(5000).default(''),
    required: z.boolean().default(false),
    choices: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
    multiple: z.boolean().default(false),
    display: z.enum(['radio', 'dropdown']).default('radio'),
    min: z.number().nullable().default(null),
    max: z.number().nullable().default(null),
  })
  .superRefine((v, c) => {
    if (v.type !== 'pagebreak' && !v.label)
      c.addIssue({ code: 'custom', message: 'errors.field.required', path: ['label'] });
    if (v.type === 'choice' && v.choices.length < 2)
      c.addIssue({ code: 'custom', message: 'mod.feedback.errors.twoOptions', path: ['choices'] });
    if (v.type === 'number' && v.min !== null && v.max !== null && v.min > v.max)
      c.addIssue({ code: 'custom', message: 'errors.common.minAboveMax', path: ['max'] });
  });
type ItemData = z.output<typeof ItemInput>;

function itemRow(v: ItemData) {
  return {
    type: v.type,
    label: v.type === 'pagebreak' ? '' : v.label,
    required: ANSWERED.includes(v.type) && v.required,
    options:
      v.type === 'choice'
        ? { choices: v.choices, multiple: v.multiple, display: v.multiple ? 'radio' : v.display }
        : v.type === 'number'
          ? { min: v.min, max: v.max }
          : {},
  };
}

function toItem(r: {
  id: string;
  sortOrder: number;
  type: string;
  label: string;
  required: boolean;
  options: unknown;
}): Item {
  const o = (r.options ?? {}) as Partial<Item>;
  return {
    id: r.id,
    sortOrder: r.sortOrder,
    type: (ITEM_TYPES as readonly string[]).includes(r.type) ? (r.type as ItemType) : 'info',
    label: r.label,
    required: r.required,
    choices: Array.isArray(o.choices) ? o.choices.map(String) : [],
    multiple: o.multiple === true,
    display: o.display === 'dropdown' ? 'dropdown' : 'radio',
    min: typeof o.min === 'number' ? o.min : null,
    max: typeof o.max === 'number' ? o.max : null,
  };
}

export async function feedbackItems(ctx: ModuleCtx, activityId: string): Promise<Item[]> {
  const rows = await ctx.db.feedbackItem.findMany({
    where: { activityId },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map(toItem);
}

export function feedbackState(s: FeedbackSettingsT, now: Date): 'notOpen' | 'open' | 'closed' {
  if (s.opensAt && now < new Date(s.opensAt)) return 'notOpen';
  if (s.closesAt && now >= new Date(s.closesAt)) return 'closed';
  return 'open';
}

const uid = (ctx: ModuleCtx) => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);

export async function mySubmissions(ctx: ModuleCtx, a: ActivityRef): Promise<number> {
  const me = uid(ctx);
  return me ? ctx.db.feedbackResponse.count({ where: { activityId: a.id, userId: me } }) : 0;
}

export interface ItemSummary {
  id: string;
  number: number;
  type: ItemType;
  label: string;
  answered: number;
  choices?: { text: string; count: number; percent: number }[];
  numbers?: { average: number; min: number; max: number } | null;
  /** Text answers, for those who may see the responses. */
  texts?: string[];
}

/**
 * The summary of the responses. Learners get it after answering when the settings show
 * it, without text answers; people who see the responses get everything.
 */
export async function feedbackAnalysis(ctx: ModuleCtx, ref: ActivityRef) {
  const a = ref as Feedback;
  const teacher = await ctx.perm.can('mod.feedback:viewreports', a.id);
  const visible = teacher || (a.settings.showAnalysis && (await mySubmissions(ctx, a)) > 0);
  if (!visible) return { visible: false as const };
  const [items, responses] = await Promise.all([
    feedbackItems(ctx, a.id),
    ctx.db.feedbackResponse.findMany({ where: { activityId: a.id }, select: { answers: true } }),
  ]);
  const answers = responses.map((r) => (r.answers ?? {}) as Record<string, Answer>);
  const numbers = itemNumbers(items);
  const summary: ItemSummary[] = items
    .filter((i) => ANSWERED.includes(i.type))
    .map((i) => {
      const given = answers.map((x) => x[i.id]).filter((v) => v !== undefined);
      const base = {
        id: i.id,
        number: numbers.get(i.id)!,
        type: i.type,
        label: i.label,
        answered: given.length,
      };
      if (i.type === 'choice') {
        const picks = given.flatMap((v) => (Array.isArray(v) ? v : [String(v)]));
        return {
          ...base,
          choices: i.choices.map((text) => {
            const count = picks.filter((p) => p === text).length;
            return {
              text,
              count,
              percent: given.length ? Math.round((count / given.length) * 100) : 0,
            };
          }),
        };
      }
      if (i.type === 'number') {
        const ns = given.map(Number).filter(Number.isFinite);
        return {
          ...base,
          numbers: ns.length
            ? {
                average: Math.round((ns.reduce((x, y) => x + y, 0) / ns.length) * 100) / 100,
                min: Math.min(...ns),
                max: Math.max(...ns),
              }
            : null,
        };
      }
      return teacher ? { ...base, texts: given.map(String) } : base;
    });
  return { visible: true as const, responses: responses.length, items: summary };
}

/** Responses for people who see them: anonymous ones without a name. */
export async function feedbackResponses(ctx: ModuleCtx, a: ActivityRef) {
  await ctx.perm.require('mod.feedback:viewreports', a.id);
  const rows = await ctx.db.feedbackResponse.findMany({
    where: { activityId: a.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      anonymous: true,
      answers: true,
      createdAt: true,
      user: { select: { id: true, name: true, username: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    answers: (r.answers ?? {}) as Record<string, Answer>,
    user: r.anonymous ? null : r.user,
  }));
}

/** Rows of the responses export: who (unless anonymous), when, then one column per question. */
export async function responseSheet(ctx: ModuleCtx, a: ActivityRef): Promise<Cell[][]> {
  const [items, responses] = await Promise.all([
    feedbackItems(ctx, a.id),
    feedbackResponses(ctx, a),
  ]);
  const questions = items.filter((i) => ANSWERED.includes(i.type));
  const numbers = itemNumbers(items);
  return [
    [
      'name',
      'username',
      'submittedAt',
      ...questions.map((q) => `${numbers.get(q.id)}. ${q.label}`),
    ],
    ...responses.map((r) => [
      r.user?.name ?? '',
      r.user?.username ?? '',
      r.createdAt.toISOString(),
      ...questions.map((q) => {
        const v = r.answers[q.id];
        return Array.isArray(v) ? v.join('; ') : (v ?? '');
      }),
    ]),
  ];
}

async function itemOf(ctx: ModuleCtx, a: ActivityRef, id: string) {
  const it = await ctx.db.feedbackItem.findFirst({ where: { id, activityId: a.id } });
  if (!it) throw new ModuleError('NOT_FOUND', msg('mod.feedback.errors.noQuestion'));
  return it;
}

async function renumber(ctx: ModuleCtx, ids: string[]) {
  for (const [i, id] of ids.entries())
    await ctx.db.feedbackItem.update({ where: { id }, data: { sortOrder: i } });
}

const ExportedItem = z.object({
  type: z.enum(ITEM_TYPES),
  label: z.string(),
  required: z.boolean(),
  options: z.unknown(),
});

export const feedback = defineModule<FeedbackSettingsT>({
  key: 'feedback',
  archetype: 'activity',
  icon: 'ClipboardList',
  supports: { viewCompletion: true },
  settings: {
    schema: FeedbackSettings as unknown as z.ZodType<FeedbackSettingsT>,
    defaults: () => FeedbackSettings.parse({}),
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
    schema: z.object({ submitted: bool(false) }),
    async evaluate(ctx, a, userId, rules) {
      if (!(rules as { submitted: boolean }).submitted) return 'complete';
      const n = await ctx.db.feedbackResponse.count({ where: { activityId: a.id, userId } });
      return n ? 'complete' : 'incomplete';
    },
  },
  notifications: { submitted: { email: 'OFF', inApp: true } },
  reset: {
    async userData(ctx, a) {
      await ctx.db.feedbackResponse.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return ctx.db.feedbackResponse.findMany({
        where: { userId },
        select: { activityId: true, answers: true, createdAt: true },
      });
    },
    async erase(ctx, userId) {
      await ctx.db.feedbackResponse.deleteMany({ where: { userId } });
    },
  },
  ai: { tutorPolicy: 'exclude' },
  backup: {
    async export(ctx, a) {
      return {
        items: (await feedbackItems(ctx, a.id)).map((i) => ({
          type: i.type,
          label: i.label,
          required: i.required,
          options:
            i.type === 'choice'
              ? { choices: i.choices, multiple: i.multiple, display: i.display }
              : i.type === 'number'
                ? { min: i.min, max: i.max }
                : {},
        })),
      };
    },
    async import(ctx, a, data) {
      // the archive is untrusted: items go through the same checks as when added here
      const parsed = z.object({ items: z.array(ExportedItem).max(1000) }).safeParse(data);
      if (!parsed.success) return;
      let n = 0;
      for (const it of parsed.data.items) {
        const o = (it.options ?? {}) as Partial<Item>;
        const v = ItemInput.safeParse({
          ...o,
          type: it.type,
          label: it.label,
          required: it.required,
        });
        if (!v.success) continue;
        await ctx.db.feedbackItem.create({
          data: { activityId: a.id, sortOrder: n++, ...itemRow(v.data) },
        });
      }
    },
  },
  queries: {
    items: defineQuery({
      summary: 'The questions, in order (page breaks included)',
      input: z.object({}),
      async handler(ctx, a) {
        return feedbackItems(ctx, a.id);
      },
    }),
    analysis: defineQuery({
      summary: 'The summary of the responses, as the caller may see it',
      input: z.object({}),
      async handler(ctx, a) {
        return feedbackAnalysis(ctx, a);
      },
    }),
  },
  actions: {
    addItem: defineAction({
      summary: 'Add a question, an info text or a page break',
      capability: 'mod.feedback:edititems',
      input: ItemInput.and(z.object({ afterId: z.string().uuid().nullable().default(null) })),
      async handler(ctx, a, input) {
        const items = await feedbackItems(ctx, a.id);
        const created = await ctx.db.feedbackItem.create({
          data: { activityId: a.id, sortOrder: items.length, ...itemRow(input) },
        });
        const ids = items.map((i) => i.id);
        const at = input.afterId ? ids.indexOf(input.afterId) + 1 : ids.length;
        ids.splice(at > 0 ? at : ids.length, 0, created.id);
        await renumber(ctx, ids);
        return { id: created.id };
      },
    }),
    updateItem: defineAction({
      summary: 'Change a question',
      capability: 'mod.feedback:edititems',
      input: ItemInput.and(z.object({ id: z.string().uuid() })),
      async handler(ctx, a, input) {
        await itemOf(ctx, a, input.id);
        await ctx.db.feedbackItem.update({ where: { id: input.id }, data: itemRow(input) });
        return { id: input.id };
      },
    }),
    deleteItem: defineAction({
      summary: 'Delete a question (its answers stay out of the summary)',
      capability: 'mod.feedback:edititems',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        await itemOf(ctx, a, input.id);
        await ctx.db.feedbackItem.delete({ where: { id: input.id } });
        await renumber(
          ctx,
          (await feedbackItems(ctx, a.id)).map((i) => i.id),
        );
        return { ok: true };
      },
    }),
    moveItem: defineAction({
      summary: 'Move a question one step up or down',
      capability: 'mod.feedback:edititems',
      input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
      async handler(ctx, a, input) {
        await itemOf(ctx, a, input.id);
        const ids = (await feedbackItems(ctx, a.id)).map((i) => i.id);
        const i = ids.indexOf(input.id);
        const j = input.direction === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < ids.length) {
          [ids[i], ids[j]] = [ids[j]!, ids[i]!];
          await renumber(ctx, ids);
        }
        return { ok: true };
      },
    }),
    submit: defineAction({
      summary: 'Send the answers',
      capability: 'mod.feedback:complete',
      input: z.object({ answers: z.record(z.string(), z.unknown()) }),
      async handler(ctx, ref, input) {
        const a = ref as Feedback;
        const me = uid(ctx);
        if (!me) throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
        const state = feedbackState(a.settings, ctx.now);
        if (state === 'notOpen')
          throw new ModuleError('BAD_REQUEST', msg('mod.feedback.errors.notOpenYet'));
        if (state === 'closed')
          throw new ModuleError('BAD_REQUEST', msg('mod.feedback.errors.closed'));
        if (!a.settings.multipleSubmit) {
          // one answer each: a second sending at the same moment waits here, then finds it
          await ctx.db
            .$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`feedback:${a.id}:${me}`}))::text`;
          if ((await mySubmissions(ctx, a)) > 0)
            throw new ModuleError('CONFLICT', msg('mod.feedback.errors.answeredAlready'));
        }
        const items = await feedbackItems(ctx, a.id);
        if (!items.some((i) => ANSWERED.includes(i.type)))
          throw new ModuleError('BAD_REQUEST', msg('mod.feedback.errors.noQuestions'));
        const answers = checkAnswers(items, input.answers);
        const r = await ctx.db.feedbackResponse.create({
          data: { activityId: a.id, userId: me, anonymous: a.settings.anonymous, answers },
        });
        await ctx.completion.recompute(a.id, me);
        // an anonymous answer leaves no trace of who gave it, in the course log either
        await ctx.log(
          'feedback.submitted',
          { activityId: a.id },
          { anonymous: a.settings.anonymous },
        );
        if (a.settings.notifyTeachers) {
          const teachers = await ctx.perm.usersWithCap('mod.feedback:viewreports', a.id);
          await ctx.notify.send(teachers, {
            type: 'feedback.submitted',
            title: { key: 'mod.feedback.notify.submittedTitle', values: { name: a.name } },
            url: `/course/${a.courseId}/a/${a.id}?tab=responses`,
            courseId: a.courseId,
            contextId: a.id,
            anonymous: a.settings.anonymous,
          });
        }
        return { id: r.id };
      },
    }),
    deleteResponse: defineAction({
      summary: 'Delete a response',
      capability: 'mod.feedback:deleteresponses',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        const r = await ctx.db.feedbackResponse.findFirst({
          where: { id: input.id, activityId: a.id },
          select: { userId: true },
        });
        if (!r) throw new ModuleError('NOT_FOUND', msg('mod.feedback.errors.noResponse'));
        await ctx.db.feedbackResponse.delete({ where: { id: input.id } });
        await ctx.completion.recompute(a.id, r.userId);
        return { ok: true };
      },
    }),
  },
  async http(ctx, req, p) {
    // GET /api/mod/feedback/<activityId>/responses.(csv|xlsx)
    const [activityId, file] = p;
    const format = file === 'responses.csv' ? 'csv' : file === 'responses.xlsx' ? 'xlsx' : null;
    if (req.method !== 'GET' || !activityId || !format)
      return new Response('Not found', { status: 404 });
    const access = await ctx.activities.get(activityId);
    if (!access?.canOpen || !(await ctx.perm.can('mod.feedback:viewreports', activityId)))
      return new Response('Forbidden', { status: 403 });
    const rows = await responseSheet(ctx, access.activity);
    const headers = {
      'Content-Disposition': `attachment; filename="responses.${format}"`,
      'Cache-Control': 'private, no-store',
    };
    if (format === 'xlsx')
      return new Response(Buffer.from(writeXlsx(rows, 'Responses')), {
        headers: {
          ...headers,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });
    return new Response(csvFile(rows), {
      headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8' },
    });
  },
});

export const feedbackModules = [feedback];
