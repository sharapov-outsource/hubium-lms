import type { Prisma } from '@hubium/db';
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
import { bool } from '@hubium/module-sdk/fields';
import {
  aggregateRatings,
  inRatingWindow,
  type RatingAggregate,
  ratingFields,
  scaleItems,
} from '@hubium/module-sdk/ratings';
import { z } from 'zod';

// mod-glossary: terms and their definitions, as Moodle's glossary. Teachers and learners
// write entries (learners' may wait for approval); entries are browsed by letter and
// category or searched, can be rated (the ratings of a learner's entries make a grade),
// and with linking on, the course's texts link the concepts to their entries.

export const GlossarySettings = z
  .object({
    /** Learners' entries wait for a teacher before others see them. */
    approvalRequired: bool(false),
    /** The same concept may be entered more than once. */
    allowDuplicates: bool(false),
    /** Authors may change and delete their entries. */
    allowEditing: bool(true),
    /** The course's texts link the concepts of entries marked for it. */
    autoLink: bool(false),
    /** dictionary: concepts and definitions; full: with authors and dates. */
    displayFormat: z.enum(['dictionary', 'full']).default('dictionary'),
    entriesPerPage: z.coerce.number().int().min(5).max(200).default(20),
    ...ratingFields,
  })
  .refine((s) => !s.ratingFrom || !s.ratingTo || s.ratingTo > s.ratingFrom, {
    message: 'The end of the rating window must be after its start',
    path: ['ratingTo'],
  })
  .refine((s) => s.ratingPass === undefined || s.ratingPass <= s.ratingMax, {
    message: 'Pass grade exceeds maximum',
    path: ['ratingPass'],
  });
export type GlossarySettingsT = z.output<typeof GlossarySettings>;
type Glossary = ActivityRef<GlossarySettingsT>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uid = (ctx: ModuleCtx) => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);

const words = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.split(/[,\n]/) : v),
    z.array(z.string().trim().max(255)),
  )
  .transform((list) => [...new Set(list.filter(Boolean))].slice(0, 50))
  .default([]);

export const EntryInput = z.object({
  concept: z.string().trim().min(1, 'Required').max(255),
  definition: z.string().max(200_000).default(''),
  aliases: words,
  categories: words,
  autoLink: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  fullMatch: z.boolean().default(true),
});

/** The first letter an entry is filed under in the index ("#" for anything else). */
export function indexLetter(concept: string): string {
  const c = concept.trim().charAt(0).toLocaleUpperCase();
  return /\p{L}/u.test(c) ? c : '#';
}

const entrySelect = {
  id: true,
  concept: true,
  definition: true,
  aliases: true,
  categories: true,
  approved: true,
  autoLink: true,
  caseSensitive: true,
  fullMatch: true,
  createdAt: true,
  updatedAt: true,
  authorId: true,
  author: { select: { id: true, name: true } },
} satisfies Prisma.GlossaryEntrySelect;

/** Entries the user may see: approved ones, their own, and all of them for teachers. */
async function visibleWhere(
  ctx: ModuleCtx,
  a: ActivityRef,
): Promise<Prisma.GlossaryEntryWhereInput> {
  if (await ctx.perm.can('mod.glossary:manageentries', a.id)) return { activityId: a.id };
  const me = uid(ctx);
  return {
    activityId: a.id,
    OR: [{ approved: true }, ...(me ? [{ authorId: me }] : [])],
  };
}

export interface EntryRating {
  aggregate: number | null;
  count: number;
  mine: number | null;
  canRate: boolean;
  raters: { name: string; value: number }[];
}

/**
 * Entries of a page of the glossary with what the user may do with them and their
 * ratings; `letters` and `categories` are those of every entry the user may see.
 */
export async function glossaryEntries(
  ctx: ModuleCtx,
  ref: ActivityRef,
  q: {
    search?: string;
    letter?: string;
    category?: string;
    pending?: boolean;
    entryId?: string;
    page?: number;
  },
) {
  const a = ref as Glossary;
  const s = a.settings;
  const me = uid(ctx);
  const where = await visibleWhere(ctx, a);
  const all = await ctx.db.glossaryEntry.findMany({
    where,
    select: { concept: true, categories: true },
  });
  const search = q.search?.trim();
  const filtered: Prisma.GlossaryEntryWhereInput = {
    AND: [
      where,
      ...(q.pending ? [{ approved: false }] : []),
      // an id from a link that is not one matches nothing
      ...(q.entryId ? [UUID.test(q.entryId) ? { id: q.entryId } : { id: { in: [] } }] : []),
      ...(q.category ? [{ categories: { has: q.category } }] : []),
      ...(search
        ? [
            {
              OR: [
                { concept: { contains: search, mode: 'insensitive' as const } },
                { definition: { contains: search, mode: 'insensitive' as const } },
                { aliases: { has: search } },
              ],
            },
          ]
        : []),
    ],
  };
  // the letter filter runs here: "#" gathers what does not start with a letter
  const matching = (
    await ctx.db.glossaryEntry.findMany({
      where: filtered,
      orderBy: [{ concept: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, concept: true },
    })
  ).filter((e) => !q.letter || indexLetter(e.concept) === q.letter);
  const page = Math.max(1, q.page ?? 1);
  const ids = matching
    .slice((page - 1) * s.entriesPerPage, page * s.entriesPerPage)
    .map((e) => e.id);
  const rows = await ctx.db.glossaryEntry.findMany({
    where: { id: { in: ids } },
    select: entrySelect,
  });
  rows.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
  const [manage, ratings] = await Promise.all([
    ctx.perm.can('mod.glossary:manageentries', a.id),
    entryRatings(ctx, a, rows),
  ]);
  return {
    total: matching.length,
    page,
    pageSize: s.entriesPerPage,
    letters: [...new Set(all.map((e) => indexLetter(e.concept)))].sort((x, y) =>
      x === '#' ? 1 : y === '#' ? -1 : x.localeCompare(y),
    ),
    categories: [...new Set(all.flatMap((e) => e.categories))].sort((x, y) => x.localeCompare(y)),
    pendingCount: manage
      ? await ctx.db.glossaryEntry.count({ where: { activityId: a.id, approved: false } })
      : 0,
    items: rows.map((e) => ({
      ...e,
      canEdit: manage || (s.allowEditing && !!me && e.authorId === me),
      canApprove: manage,
      rating: ratings.get(e.id) ?? null,
    })),
  };
}

/** Ratings of entries as the user may see them, and whether the user may rate each. */
async function entryRatings(
  ctx: ModuleCtx,
  a: Glossary,
  entries: { id: string; authorId: string | null; approved: boolean; createdAt: Date }[],
): Promise<Map<string, EntryRating>> {
  const s = a.settings;
  const out = new Map<string, EntryRating>();
  if (s.ratingAggregate === 'none' || !entries.length) return out;
  const me = uid(ctx);
  const [rater, viewAll, view, scale] = await Promise.all([
    ctx.perm.can('mod.glossary:rate', a.id),
    ctx.perm.can('mod.glossary:viewallratings', a.id),
    ctx.perm.can('mod.glossary:viewrating', a.id),
    scaleItems(ctx.db, a.courseId, s.ratingScaleId),
  ]);
  const rows = await ctx.db.glossaryRating.findMany({
    where: { entryId: { in: entries.map((e) => e.id) } },
    select: { entryId: true, raterId: true, value: true, rater: { select: { name: true } } },
  });
  for (const e of entries) {
    const rs = rows.filter((r) => r.entryId === e.id);
    out.set(e.id, {
      aggregate:
        view || viewAll
          ? aggregateRatings(
              s.ratingAggregate,
              rs.map((r) => r.value),
              scale ? scale.length : s.ratingMax,
              !!scale,
            )
          : null,
      count: rs.length,
      mine: rs.find((r) => r.raterId === me)?.value ?? null,
      canRate: rater && e.approved && e.authorId !== me && inRatingWindow(e.createdAt, s),
      raters: viewAll ? rs.map((r) => ({ name: r.rater.name, value: r.value })) : [],
    });
  }
  return out;
}

/** A learner's grade: the aggregate of the ratings of their approved entries in the window. */
async function ratingGrade(ctx: ModuleCtx, a: Glossary, userId: string): Promise<number | null> {
  const s = a.settings;
  const scale = await scaleItems(ctx.db, a.courseId, s.ratingScaleId);
  const rows = await ctx.db.glossaryRating.findMany({
    where: {
      entry: {
        activityId: a.id,
        authorId: userId,
        approved: true,
        createdAt: {
          ...(s.ratingFrom ? { gte: new Date(s.ratingFrom) } : {}),
          ...(s.ratingTo ? { lte: new Date(s.ratingTo) } : {}),
        },
      },
    },
    select: { value: true },
  });
  return aggregateRatings(
    s.ratingAggregate,
    rows.map((r) => r.value),
    scale ? scale.length : s.ratingMax,
    !!scale,
  );
}

async function pushGrades(ctx: ModuleCtx, a: Glossary, userIds: (string | null)[]) {
  if (a.settings.ratingAggregate === 'none') return;
  const ids = [...new Set(userIds.filter((u): u is string => !!u))];
  const grades = [];
  for (const userId of ids)
    grades.push({ userId, itemNumber: 0, rawGrade: await ratingGrade(ctx, a, userId) });
  if (grades.length) await ctx.grades.setGrades(a.id, grades);
}

async function entryOf(ctx: ModuleCtx, a: ActivityRef, id: string) {
  const e = await ctx.db.glossaryEntry.findFirst({ where: { id, activityId: a.id } });
  if (!e) throw new ModuleError('NOT_FOUND', msg('mod.glossary.errors.noEntry'));
  return e;
}

/** Authors may change their entries when the glossary allows it; teachers always. */
async function mayEdit(ctx: ModuleCtx, a: Glossary, authorId: string | null) {
  if (await ctx.perm.can('mod.glossary:manageentries', a.id)) return true;
  return a.settings.allowEditing && !!authorId && authorId === uid(ctx);
}

async function checkDuplicate(ctx: ModuleCtx, a: Glossary, concept: string, except?: string) {
  if (a.settings.allowDuplicates) return;
  const same = await ctx.db.glossaryEntry.findFirst({
    where: {
      activityId: a.id,
      concept: { equals: concept, mode: 'insensitive' },
      ...(except ? { id: { not: except } } : {}),
    },
    select: { id: true },
  });
  if (same) throw new ModuleError('CONFLICT', msg('mod.glossary.errors.conceptExists'));
}

/** Rewrites ids an import mapped (files in definitions). */
function rewriteIds(text: string, map: (old: string) => string | undefined) {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (m) => map(m.toLowerCase()) ?? m,
  );
}

const ExportedEntry = EntryInput.extend({ definition: z.string().max(200_000) });

export const glossary = defineModule<GlossarySettingsT>({
  key: 'glossary',
  archetype: 'activity',
  icon: 'BookA',
  supports: { viewCompletion: true, backup: true, grading: true },
  settings: {
    schema: GlossarySettings as unknown as z.ZodType<GlossarySettingsT>,
    defaults: () => GlossarySettings.parse({}),
  },
  grading: {
    items: (a) =>
      a.settings.ratingAggregate === 'none'
        ? []
        : [
            {
              itemNumber: 0,
              name: a.name,
              gradeMax: a.settings.ratingMax,
              gradePass: a.settings.ratingPass,
              scaleId: a.settings.ratingScaleId,
            },
          ],
  },
  completion: {
    schema: z.object({
      entries: z.preprocess(
        (v) => (v === '' || v === null ? undefined : v),
        z.coerce.number().int().min(1).max(1000).optional(),
      ),
    }),
    async evaluate(ctx, a, userId, rules) {
      const need = (rules as { entries?: number }).entries;
      if (!need) return 'complete';
      const n = await ctx.db.glossaryEntry.count({
        where: { activityId: a.id, authorId: userId, approved: true },
      });
      return n >= need ? 'complete' : 'incomplete';
    },
  },
  autoLinks: async (ctx, a) => {
    if (!a.settings.autoLink) return [];
    const rows = await ctx.db.glossaryEntry.findMany({
      where: { activityId: a.id, approved: true, autoLink: true },
      select: { id: true, concept: true, aliases: true, caseSensitive: true, fullMatch: true },
    });
    return rows.map((e) => ({
      words: [e.concept, ...e.aliases],
      url: `/course/${a.courseId}/a/${a.id}?entry=${e.id}`,
      title: `${a.name}: ${e.concept}`,
      caseSensitive: e.caseSensitive,
      fullMatch: e.fullMatch,
    }));
  },
  ai: {
    async extract(ctx, a) {
      const rows = await ctx.db.glossaryEntry.findMany({
        where: { activityId: a.id, approved: true },
        orderBy: { concept: 'asc' },
        select: { concept: true, definition: true },
      });
      return rows.map((e) => ({ title: e.concept, text: e.definition }));
    },
  },
  reset: {
    // entries by teachers are course material and stay; learners' go with all ratings
    async userData(ctx, a) {
      await ctx.db.glossaryRating.deleteMany({ where: { entry: { activityId: a.id } } });
      await ctx.db.glossaryEntry.deleteMany({
        where: { activityId: a.id, byStaff: false, authorId: { not: null } },
      });
    },
  },
  privacy: {
    async export(ctx, userId) {
      const [entries, ratings] = await Promise.all([
        ctx.db.glossaryEntry.findMany({
          where: { authorId: userId },
          select: { activityId: true, concept: true, definition: true, createdAt: true },
        }),
        ctx.db.glossaryRating.findMany({
          where: { raterId: userId },
          select: { entryId: true, value: true, createdAt: true },
        }),
      ]);
      return { entries, ratings };
    },
    async erase(ctx, userId) {
      await ctx.db.glossaryRating.deleteMany({ where: { raterId: userId } });
      await ctx.db.glossaryEntry.deleteMany({ where: { authorId: userId } });
    },
  },
  backup: {
    // teachers' entries are the glossary's content; learners' entries and ratings are
    // users' data, and authors are not carried
    async export(ctx, a) {
      return {
        entries: await ctx.db.glossaryEntry.findMany({
          where: {
            activityId: a.id,
            approved: true,
            OR: [{ authorId: null }, { byStaff: true }],
          },
          orderBy: { concept: 'asc' },
          select: {
            concept: true,
            definition: true,
            aliases: true,
            categories: true,
            autoLink: true,
            caseSensitive: true,
            fullMatch: true,
          },
        }),
      };
    },
    async import(ctx, a, data, map) {
      const parsed = z.object({ entries: z.array(ExportedEntry).max(20_000) }).safeParse(data);
      if (!parsed.success) return;
      await ctx.db.glossaryEntry.createMany({
        data: parsed.data.entries.map((e) => ({
          activityId: a.id,
          byStaff: true,
          ...e,
          definition: sanitizeRichText(rewriteIds(e.definition, map)),
        })),
      });
    },
  },
  lifecycle: {
    // new rating settings change every rating grade; the item comes and goes with them
    async onUpdate(ctx, ref, prev) {
      const a = ref as Glossary;
      const keys = [
        'ratingAggregate',
        'ratingScaleId',
        'ratingMax',
        'ratingFrom',
        'ratingTo',
      ] as const;
      if (!keys.some((k) => a.settings[k] !== prev[k])) return;
      await ctx.grades.syncItems(a.id);
      const authors = await ctx.db.glossaryEntry.findMany({
        where: { activityId: a.id, authorId: { not: null } },
        select: { authorId: true },
        distinct: ['authorId'],
      });
      await pushGrades(
        ctx,
        a,
        authors.map((e) => e.authorId),
      );
    },
  },
  queries: {
    entries: defineQuery({
      summary: 'Entries the caller may see: by letter, category or a search, a page at a time',
      input: z.object({
        search: z.string().max(200).optional(),
        letter: z.string().max(2).optional(),
        category: z.string().max(255).optional(),
        page: z.coerce.number().int().min(1).default(1),
      }),
      async handler(ctx, a, input) {
        return glossaryEntries(ctx, a, input);
      },
    }),
    entry: defineQuery({
      summary: 'One entry',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        const e = await ctx.db.glossaryEntry.findFirst({
          where: { AND: [await visibleWhere(ctx, a), { id: input.id }] },
          select: entrySelect,
        });
        if (!e) throw new ModuleError('NOT_FOUND', msg('mod.glossary.errors.noEntry'));
        return e;
      },
    }),
  },
  actions: {
    addEntry: defineAction({
      summary: 'Add an entry (a learner’s may wait for approval)',
      capability: 'mod.glossary:write',
      input: EntryInput,
      async handler(ctx, ref, input) {
        const a = ref as Glossary;
        const me = uid(ctx);
        if (!me) throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
        await checkDuplicate(ctx, a, input.concept);
        const manage = await ctx.perm.can('mod.glossary:manageentries', a.id);
        const e = await ctx.db.glossaryEntry.create({
          data: {
            activityId: a.id,
            authorId: me,
            ...input,
            definition: sanitizeRichText(input.definition),
            approved: manage || !a.settings.approvalRequired,
            // course material rather than a learner's work, whoever teaches later
            byStaff: manage,
          },
        });
        await ctx.completion.recompute(a.id, me);
        await ctx.log('glossary.entry.created', { activityId: a.id, entryId: e.id });
        return { id: e.id, approved: e.approved };
      },
    }),
    updateEntry: defineAction({
      summary: 'Change an entry',
      capability: 'mod.glossary:write',
      input: EntryInput.extend({ id: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Glossary;
        const e = await entryOf(ctx, a, input.id);
        if (!(await mayEdit(ctx, a, e.authorId)))
          throw new ModuleError('FORBIDDEN', msg('mod.glossary.errors.cannotChange'));
        await checkDuplicate(ctx, a, input.concept, e.id);
        const { id, ...data } = input;
        // where entries need approval, a change by anyone but a moderator needs it again
        const recheck =
          a.settings.approvalRequired && !(await ctx.perm.can('mod.glossary:manageentries', a.id));
        await ctx.db.glossaryEntry.update({
          where: { id },
          data: {
            ...data,
            definition: sanitizeRichText(data.definition),
            ...(recheck ? { approved: false } : {}),
          },
        });
        if (recheck && e.approved) {
          if (e.authorId) await ctx.completion.recompute(a.id, e.authorId);
          await pushGrades(ctx, a, e.authorId ? [e.authorId] : []);
        }
        return { id };
      },
    }),
    deleteEntry: defineAction({
      summary: 'Delete an entry',
      capability: 'mod.glossary:write',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Glossary;
        const e = await entryOf(ctx, a, input.id);
        if (!(await mayEdit(ctx, a, e.authorId)))
          throw new ModuleError('FORBIDDEN', msg('mod.glossary.errors.cannotDelete'));
        await ctx.db.glossaryEntry.delete({ where: { id: e.id } });
        await pushGrades(ctx, a, [e.authorId]);
        if (e.authorId) await ctx.completion.recompute(a.id, e.authorId);
        return { ok: true };
      },
    }),
    approveEntry: defineAction({
      summary: 'Approve an entry, or take the approval back',
      capability: 'mod.glossary:manageentries',
      input: z.object({ id: z.string().uuid(), approved: z.boolean() }),
      async handler(ctx, ref, input) {
        const a = ref as Glossary;
        const e = await entryOf(ctx, a, input.id);
        await ctx.db.glossaryEntry.update({
          where: { id: e.id },
          data: { approved: input.approved },
        });
        await pushGrades(ctx, a, [e.authorId]);
        if (e.authorId) await ctx.completion.recompute(a.id, e.authorId);
        return { ok: true };
      },
    }),
    rate: defineAction({
      summary:
        'Rate an entry (null takes your rating back): points 0..max, or a 1-based position on the scale',
      capability: 'mod.glossary:rate',
      input: z.object({ entryId: z.string().uuid(), value: z.number().int().nullable() }),
      async handler(ctx, ref, input) {
        const a = ref as Glossary;
        const me = uid(ctx);
        if (!me) throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
        if (a.settings.ratingAggregate === 'none')
          throw new ModuleError('CONFLICT', msg('mod.glossary.errors.ratingsOff'));
        const e = await entryOf(ctx, a, input.entryId);
        if (
          !e.approved ||
          !e.authorId ||
          e.authorId === me ||
          !inRatingWindow(e.createdAt, a.settings)
        )
          throw new ModuleError('FORBIDDEN', msg('mod.glossary.errors.cannotRate'));
        if (input.value === null)
          await ctx.db.glossaryRating.deleteMany({ where: { entryId: e.id, raterId: me } });
        else {
          const scale = await scaleItems(ctx.db, a.courseId, a.settings.ratingScaleId);
          const [lo, hi] = scale ? [1, scale.length] : [0, a.settings.ratingMax];
          if (input.value < lo || input.value > hi)
            throw new ModuleError(
              'BAD_REQUEST',
              msg('mod.glossary.errors.ratingRange', { lo, hi }),
            );
          await ctx.db.glossaryRating.upsert({
            where: { entryId_raterId: { entryId: e.id, raterId: me } },
            create: { entryId: e.id, raterId: me, value: input.value },
            update: { value: input.value },
          });
        }
        await pushGrades(ctx, a, [e.authorId]);
        return { ok: true };
      },
    }),
  },
});

export type { RatingAggregate };
export const glossaryModules = [glossary];
