import { randomUUID } from 'node:crypto';
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
import { visibleGroupFilter } from '@hubium/module-sdk/groups';
import { z } from 'zod';

// mod-choice: one question with options, as Moodle's choice. Options live in the
// settings with stable ids; answers are rows (several when multiple answers are allowed).
// Results show to learners as the settings say: never, after answering, after closing or
// always, with or without names; teachers see who chose what and can download it.

const ChoiceOption = z.object({
  id: z.string().max(64).optional(),
  text: z.string().trim().min(1, 'errors.field.required').max(255),
  /** Most answers the option takes when answers are limited (0 = no limit). */
  limit: z.coerce.number().int().min(0).max(100_000).default(0),
});

/** The options arrive from the settings form as JSON. */
const Options = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  },
  z
    .array(ChoiceOption)
    .min(1, 'mod.choice.errors.addOption')
    .max(100)
    .transform((list) => list.map((o) => ({ ...o, id: o.id || randomUUID() }))),
);

export const ChoiceSettings = z
  .object({
    options: Options,
    allowMultiple: bool(false),
    /** Learners may change or withdraw their answer while the choice is open. */
    allowUpdate: bool(true),
    limitAnswers: bool(false),
    showResults: z.enum(['never', 'afterAnswer', 'afterClose', 'always']).default('afterAnswer'),
    publish: z.enum(['anonymous', 'names']).default('anonymous'),
    /** Learners see who has not answered yet (with names published). */
    showUnanswered: bool(false),
    opensAt: isoDate,
    closesAt: isoDate,
    /** Options are shown before the choice opens. */
    showPreview: bool(false),
  })
  .refine((s) => !s.opensAt || !s.closesAt || s.closesAt > s.opensAt, {
    message: 'errors.common.afterOpening',
    path: ['closesAt'],
  })
  .refine((s) => new Set(s.options.map((o) => o.id)).size === s.options.length, {
    message: 'mod.choice.errors.distinctOptions',
    path: ['options'],
  });

export type ChoiceSettingsT = z.output<typeof ChoiceSettings>;
type Choice = ActivityRef<ChoiceSettingsT>;

export function choiceState(s: ChoiceSettingsT, now: Date): 'notOpen' | 'open' | 'closed' {
  if (s.opensAt && now < new Date(s.opensAt)) return 'notOpen';
  if (s.closesAt && now >= new Date(s.closesAt)) return 'closed';
  return 'open';
}

const uid = (ctx: ModuleCtx) => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);

export async function myAnswers(ctx: ModuleCtx, a: ActivityRef): Promise<string[]> {
  const me = uid(ctx);
  if (!me) return [];
  const rows = await ctx.db.choiceAnswer.findMany({
    where: { activityId: a.id, userId: me },
    select: { optionId: true },
  });
  return rows.map((r) => r.optionId);
}

export interface ChoiceResults {
  /** Whether the viewer may see the results at all. */
  visible: boolean;
  /** Names come with the results (teachers, or published names). */
  names: boolean;
  options: {
    id: string;
    text: string;
    limit: number;
    count: number;
    users: { id: string; name: string }[];
  }[];
  /** People who answered, among those counted. */
  answered: number;
  unanswered: { id: string; name: string }[] | null;
}

/**
 * Results as the viewer may see them. Separate groups limit learners to their groups;
 * teachers (mod.choice:readresponses) see everything with names.
 */
export async function choiceResults(ctx: ModuleCtx, ref: ActivityRef): Promise<ChoiceResults> {
  const a = ref as Choice;
  const s = a.settings;
  const me = uid(ctx);
  const teacher = await ctx.perm.can('mod.choice:readresponses', a.id);
  const mine = me ? await myAnswers(ctx, a) : [];
  const state = choiceState(s, ctx.now);
  const visible =
    teacher ||
    s.showResults === 'always' ||
    (s.showResults === 'afterAnswer' && mine.length > 0) ||
    (s.showResults === 'afterClose' && state === 'closed');
  const names = teacher || s.publish === 'names';
  const groups = me ? await visibleGroupFilter(ctx.db, a, me, teacher) : null;
  const inGroups = groups
    ? new Set(
        (
          await ctx.db.groupMember.findMany({
            where: { groupId: { in: groups } },
            select: { userId: true },
          })
        ).map((m) => m.userId),
      )
    : null;
  const rows = visible
    ? (
        await ctx.db.choiceAnswer.findMany({
          where: { activityId: a.id },
          orderBy: { createdAt: 'asc' },
          select: { optionId: true, user: { select: { id: true, name: true } } },
        })
      ).filter((r) => !inGroups || inGroups.has(r.user.id))
    : [];
  const options = s.options.map((o) => {
    const users = rows.filter((r) => r.optionId === o.id).map((r) => r.user);
    return {
      id: o.id!,
      text: o.text,
      limit: s.limitAnswers ? o.limit : 0,
      count: users.length,
      users: names ? users : [],
    };
  });
  const answeredIds = new Set(rows.map((r) => r.user.id));
  let unanswered: ChoiceResults['unanswered'] = null;
  if (visible && names && (teacher || s.showUnanswered)) {
    const eligible = (await ctx.perm.usersWithCap('mod.choice:choose', a.id)).filter(
      (id) => !answeredIds.has(id) && (!inGroups || inGroups.has(id)),
    );
    unanswered = await ctx.db.user.findMany({
      where: { id: { in: eligible } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
  return { visible, names, options, answered: answeredIds.size, unanswered };
}

/**
 * Answers taken per option by everyone but `except` (for limits): places left are shown
 * and enforced whether or not the results may be seen.
 */
export async function takenPlaces(ctx: ModuleCtx, a: ActivityRef, except?: string | null) {
  const rows = await ctx.db.choiceAnswer.groupBy({
    by: ['optionId'],
    where: { activityId: a.id, ...(except ? { userId: { not: except } } : {}) },
    _count: true,
  });
  return new Map(rows.map((r) => [r.optionId, r._count]));
}

export const choice = defineModule<ChoiceSettingsT>({
  key: 'choice',
  archetype: 'activity',
  icon: 'ListChecks',
  supports: { viewCompletion: true, backup: true, groups: true },
  settings: {
    schema: ChoiceSettings as unknown as z.ZodType<ChoiceSettingsT>,
    defaults: () => ({
      options: [],
      allowMultiple: false,
      allowUpdate: true,
      limitAnswers: false,
      showResults: 'afterAnswer',
      publish: 'anonymous',
      showUnanswered: false,
      opensAt: null,
      closesAt: null,
      showPreview: false,
    }),
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
      const n = await ctx.db.choiceAnswer.count({ where: { activityId: a.id, userId } });
      return n ? 'complete' : 'incomplete';
    },
  },
  lifecycle: {
    // answers to options that are gone go too
    async onUpdate(ctx, a) {
      // answers to options taken away go; completing by answering follows for their authors
      const gone = { activityId: a.id, optionId: { notIn: a.settings.options.map((o) => o.id!) } };
      const authors = await ctx.db.choiceAnswer.findMany({
        where: gone,
        select: { userId: true },
        distinct: ['userId'],
      });
      await ctx.db.choiceAnswer.deleteMany({ where: gone });
      for (const { userId } of authors) await ctx.completion.recompute(a.id, userId);
    },
  },
  reset: {
    async userData(ctx, a) {
      await ctx.db.choiceAnswer.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return ctx.db.choiceAnswer.findMany({
        where: { userId },
        select: { activityId: true, optionId: true, createdAt: true },
      });
    },
    async erase(ctx, userId) {
      await ctx.db.choiceAnswer.deleteMany({ where: { userId } });
    },
  },
  ai: { tutorPolicy: 'exclude' },
  queries: {
    results: defineQuery({
      summary: 'The options with their counts (and names), as the caller may see them',
      input: z.object({}),
      async handler(ctx, a) {
        return { mine: await myAnswers(ctx, a), ...(await choiceResults(ctx, a)) };
      },
    }),
  },
  actions: {
    answer: defineAction({
      summary: 'Choose one option, or several when the choice allows it',
      capability: 'mod.choice:choose',
      input: z.object({ optionIds: z.array(z.string().max(64)).min(1).max(100) }),
      async handler(ctx, ref, input) {
        const a = ref as Choice;
        const me = uid(ctx);
        if (!me) throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
        const state = choiceState(a.settings, ctx.now);
        if (state === 'notOpen')
          throw new ModuleError('BAD_REQUEST', msg('mod.choice.errors.notOpenYet'));
        if (state === 'closed')
          throw new ModuleError('BAD_REQUEST', msg('mod.choice.errors.closed'));
        const ids = [...new Set(input.optionIds)];
        if (ids.length > 1 && !a.settings.allowMultiple)
          throw new ModuleError('BAD_REQUEST', msg('mod.choice.errors.oneOnly'));
        const known = new Set(a.settings.options.map((o) => o.id));
        if (ids.some((id) => !known.has(id)))
          throw new ModuleError('NOT_FOUND', msg('mod.choice.errors.noOption'));
        // one answer at a time per choice, so that limits hold
        await ctx.db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${a.id}))::text`;
        const mine = await myAnswers(ctx, a);
        if (mine.length && !a.settings.allowUpdate)
          throw new ModuleError('CONFLICT', msg('mod.choice.errors.answeredAlready'));
        if (a.settings.limitAnswers) {
          const taken = await takenPlaces(ctx, a, me);
          for (const o of a.settings.options)
            if (ids.includes(o.id!) && o.limit > 0 && (taken.get(o.id!) ?? 0) >= o.limit)
              throw new ModuleError('CONFLICT', msg('mod.choice.errors.full', { text: o.text }));
        }
        await ctx.db.choiceAnswer.deleteMany({ where: { activityId: a.id, userId: me } });
        await ctx.db.choiceAnswer.createMany({
          data: ids.map((optionId) => ({ activityId: a.id, userId: me, optionId })),
        });
        await ctx.completion.recompute(a.id, me);
        await ctx.log('choice.answered', { activityId: a.id, options: ids.length });
        return { optionIds: ids };
      },
    }),
    withdraw: defineAction({
      summary: 'Remove your answer (when changing it is allowed)',
      capability: 'mod.choice:choose',
      input: z.object({}),
      async handler(ctx, ref) {
        const a = ref as Choice;
        const me = uid(ctx);
        if (!me) throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
        if (!a.settings.allowUpdate)
          throw new ModuleError('FORBIDDEN', msg('mod.choice.errors.noChange'));
        if (choiceState(a.settings, ctx.now) !== 'open')
          throw new ModuleError('BAD_REQUEST', msg('mod.choice.errors.closed'));
        await ctx.db.choiceAnswer.deleteMany({ where: { activityId: a.id, userId: me } });
        await ctx.completion.recompute(a.id, me);
        return { ok: true };
      },
    }),
    deleteResponses: defineAction({
      summary: "Delete people's answers",
      capability: 'mod.choice:deleteresponses',
      input: z.object({ userIds: z.array(z.string().uuid()).min(1).max(5000) }),
      async handler(ctx, a, input) {
        const r = await ctx.db.choiceAnswer.deleteMany({
          where: { activityId: a.id, userId: { in: input.userIds } },
        });
        for (const userId of input.userIds) await ctx.completion.recompute(a.id, userId);
        await ctx.log('choice.responses.deleted', {
          activityId: a.id,
          users: input.userIds.length,
        });
        return { deleted: r.count };
      },
    }),
  },
  async http(ctx, req, p) {
    // GET /api/mod/choice/<activityId>/responses.csv
    const [activityId, file] = p;
    if (req.method !== 'GET' || !activityId || file !== 'responses.csv')
      return new Response('Not found', { status: 404 });
    const access = await ctx.activities.get(activityId);
    if (!access?.canOpen || !(await ctx.perm.can('mod.choice:readresponses', activityId)))
      return new Response('Forbidden', { status: 403 });
    const s = access.activity.settings as ChoiceSettingsT;
    const text = new Map(s.options.map((o) => [o.id, o.text]));
    const rows = await ctx.db.choiceAnswer.findMany({
      where: { activityId },
      orderBy: [{ user: { name: 'asc' } }, { createdAt: 'asc' }],
      select: {
        optionId: true,
        createdAt: true,
        user: { select: { name: true, username: true, email: true, emailPlaceholder: true } },
      },
    });
    const lines = [
      ['name', 'username', 'email', 'option', 'answeredAt'],
      ...rows.map((r) => [
        r.user.name,
        r.user.username ?? '',
        r.user.emailPlaceholder ? '' : r.user.email,
        text.get(r.optionId) ?? '',
        r.createdAt.toISOString(),
      ]),
    ];
    return new Response(csvFile(lines), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="responses.csv"',
        'Cache-Control': 'private, no-store',
      },
    });
  },
});

export const choiceModules = [choice];
