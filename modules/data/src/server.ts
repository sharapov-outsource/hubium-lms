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
import { csvFile, parseCsv } from '@hubium/module-sdk/csv';
import { bool, isoDate } from '@hubium/module-sdk/fields';
import { groupsWhere, userGroupIds, visibleGroupFilter } from '@hubium/module-sdk/groups';
import {
  aggregateRatings,
  inRatingWindow,
  ratingFields,
  scaleItems,
} from '@hubium/module-sdk/ratings';
import { writeXlsx } from '@hubium/module-sdk/xlsx';
import { z } from 'zod';
import {
  cleanValue,
  compareValues,
  type Field,
  type FieldType,
  fieldTypes,
  fileTypes,
  valueText,
} from './fields.ts';

// mod-data: a database of entries, as Moodle's. The teacher defines the fields (text,
// rich text, number, date, menus, radio buttons, checkboxes, URL, file, picture) and,
// if wished, templates showing an entry in the list and on its own page with [[Field]]
// placeholders. Learners add entries, perhaps waiting for approval; entries are searched
// and sorted, rated into the gradebook, and exported to or imported from spreadsheets.

const sanitizedHtml = z
  .string()
  .max(200_000)
  .default('')
  .transform((v) => (v.trim() ? sanitizeRichText(v) : ''));

export const DataSettings = z
  .object({
    /** Learners' entries wait for a teacher before others see them. */
    approvalRequired: bool(false),
    /** Most entries a learner may add (0: no limit). */
    maxEntries: z.coerce.number().int().min(0).max(10_000).default(0),
    /** Entries a learner adds before seeing others' (0: none). */
    requiredEntriesToView: z.coerce.number().int().min(0).max(1000).default(0),
    entriesPerPage: z.coerce.number().int().min(1).max(200).default(10),
    /** Entries may be added from, and until. */
    opensAt: isoDate,
    closesAt: isoDate,
    /** Field name to sort by ('' for the time added), and the order. */
    defaultSort: z.string().max(255).default(''),
    defaultOrder: z.enum(['asc', 'desc']).default('desc'),
    /** HTML with [[Field]] and ##tags##: an entry in the list, and on its own page. */
    listTemplate: sanitizedHtml,
    singleTemplate: sanitizedHtml,
    maxFileMB: z.coerce.number().int().min(1).max(1024).default(10),
    ...ratingFields,
  })
  .refine((s) => !s.opensAt || !s.closesAt || s.closesAt > s.opensAt, {
    message: 'mod.data.errors.closeAfterOpen',
    path: ['closesAt'],
  })
  .refine((s) => !s.ratingFrom || !s.ratingTo || s.ratingTo > s.ratingFrom, {
    message: 'errors.common.ratingWindow',
    path: ['ratingTo'],
  })
  .refine((s) => s.ratingPass === undefined || s.ratingPass <= s.ratingMax, {
    message: 'errors.common.passGradeAboveMax',
    path: ['ratingPass'],
  });
export type DataSettingsT = z.output<typeof DataSettings>;
type Db = ActivityRef<DataSettingsT>;

const uid = (ctx: ModuleCtx) => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);
const me = (ctx: ModuleCtx) => {
  const id = uid(ctx);
  if (!id) throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
  return id;
};

// ── fields ──

const fieldFromRow = (r: {
  id: string;
  type: string;
  name: string;
  description: string;
  required: boolean;
  options: Prisma.JsonValue;
}): Field => ({
  id: r.id,
  type: r.type as FieldType,
  name: r.name,
  description: r.description,
  required: r.required,
  options: (r.options && typeof r.options === 'object' ? r.options : {}) as Field['options'],
});

export async function dataFields(db: Prisma.TransactionClient, activityId: string) {
  return (
    await db.dataField.findMany({ where: { activityId }, orderBy: { sortOrder: 'asc' } })
  ).map(fieldFromRow);
}

const lines = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.split(/\r?\n/) : v),
    z.array(z.string().trim().max(255)),
  )
  .transform((l) => [...new Set(l.filter(Boolean))].slice(0, 200));

export const FieldInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((n) => !/[[\]#<>]/.test(n), 'A field name cannot hold [ ] # < >'),
  description: z.string().trim().max(2000).default(''),
  required: z.boolean().default(false),
  choices: lines.default([]),
  linkText: z.string().trim().max(255).default(''),
});

function fieldRow(type: FieldType, input: z.output<typeof FieldInput>) {
  if ((type === 'menu' || type === 'radio' || type === 'checkbox') && input.choices.length < 1)
    throw new ModuleError('BAD_REQUEST', msg('mod.data.errors.giveChoices'));
  return {
    name: input.name,
    description: input.description,
    required: input.required,
    options: (type === 'menu' || type === 'radio' || type === 'checkbox'
      ? { choices: input.choices }
      : type === 'url' && input.linkText
        ? { linkText: input.linkText }
        : {}) as Prisma.InputJsonValue,
  };
}

// ── entries ──

/** Who may see what: teachers everything, others approved entries and their own. */
async function visibleWhere(ctx: ModuleCtx, a: Db): Promise<Prisma.DataRecordWhereInput> {
  const manage = await ctx.perm.can('mod.data:manageentries', a.id);
  if (manage) return { activityId: a.id };
  const user = uid(ctx);
  const groups = user ? await visibleGroupFilter(ctx.db, a, user, false) : null;
  return {
    activityId: a.id,
    OR: [
      // separate groups: their groups' entries, and those of no group (a teacher's, an
      // import, entries from before the mode), as the forum shows its discussions for all
      {
        approved: true,
        ...(groups ? { OR: [{ groupId: { in: groups } }, { groupId: null }] } : {}),
      },
      ...(user ? [{ userId: user }] : []),
    ],
  };
}

/** Learners who have not added enough entries yet see only theirs. */
async function needsOwnEntries(ctx: ModuleCtx, a: Db) {
  const need = a.settings.requiredEntriesToView;
  const user = uid(ctx);
  if (!need || !user || (await ctx.perm.can('mod.data:manageentries', a.id))) return 0;
  const n = await ctx.db.dataRecord.count({ where: { activityId: a.id, userId: user } });
  return Math.max(0, need - n);
}

export interface RecordRating {
  aggregate: number | null;
  count: number;
  mine: number | null;
  canRate: boolean;
  raters: { name: string; value: number }[];
}

/**
 * A page of entries the user may see: searched in every value and the author's name,
 * sorted by a field or the time, with values, files, rights and ratings.
 */
export async function dataRecords(
  ctx: ModuleCtx,
  ref: ActivityRef,
  q: {
    search?: string;
    sort?: string;
    order?: 'asc' | 'desc';
    page?: number;
    pending?: boolean;
    recordId?: string;
    all?: boolean;
  },
) {
  const a = ref as Db;
  const s = a.settings;
  const user = uid(ctx);
  const [fields, manage, missing] = await Promise.all([
    dataFields(ctx.db, a.id),
    ctx.perm.can('mod.data:manageentries', a.id),
    needsOwnEntries(ctx, a),
  ]);
  const where: Prisma.DataRecordWhereInput = {
    AND: [
      await visibleWhere(ctx, a),
      ...(missing && user ? [{ userId: user }] : []),
      ...(q.pending ? [{ approved: false }] : []),
      ...(q.recordId
        ? [/^[0-9a-f-]{36}$/i.test(q.recordId) ? { id: q.recordId } : { id: { in: [] } }]
        : []),
    ],
  };
  const include = {
    contents: true,
    user: { select: { id: true, name: true } },
  } satisfies Prisma.DataRecordInclude;
  const files = new Map(
    (await ctx.files.list(a.id, 'content')).map((f) => [f.id, { url: f.url, name: f.name }]),
  );
  const fileOf = (id: string) => files.get(id);
  type Row = Prisma.DataRecordGetPayload<{ include: typeof include }>;
  const valuesOf = (r: Row) =>
    Object.fromEntries(r.contents.map((c) => [c.fieldId, c.value])) as Record<string, string>;
  const search = q.search?.trim().toLocaleLowerCase();
  const sortField = fields.find((f) => f.name === (q.sort ?? s.defaultSort));
  const order = (q.order ?? s.defaultOrder) === 'asc' ? 1 : -1;
  const page = Math.max(1, q.page ?? 1);
  let total: number;
  let shown: Row[];
  if (!search && !sortField && !q.all) {
    // by the time alone: the database counts and cuts the page
    const dir = order === 1 ? ('asc' as const) : ('desc' as const);
    [total, shown] = await Promise.all([
      ctx.db.dataRecord.count({ where }),
      ctx.db.dataRecord.findMany({
        where,
        include,
        orderBy: [{ createdAt: dir }, { id: dir }],
        skip: (page - 1) * s.entriesPerPage,
        take: s.entriesPerPage,
      }),
    ]);
  } else {
    // a search reads values as people see them (option labels, file names) and a field
    // sorts by its type, so these are worked out here
    const rows = await ctx.db.dataRecord.findMany({ where, include });
    let list = rows.filter((r) => {
      if (!search) return true;
      const v = valuesOf(r);
      return (
        (r.user?.name ?? '').toLocaleLowerCase().includes(search) ||
        fields.some((f) =>
          valueText(f, v[f.id] ?? '', fileOf)
            .toLocaleLowerCase()
            .includes(search),
        )
      );
    });
    list = list.sort((x, y) => {
      const by = sortField
        ? compareValues(sortField, valuesOf(x)[sortField.id] ?? '', valuesOf(y)[sortField.id] ?? '')
        : x.createdAt.getTime() - y.createdAt.getTime();
      return by * order || (x.createdAt.getTime() - y.createdAt.getTime()) * order;
    });
    total = list.length;
    shown = q.all ? list : list.slice((page - 1) * s.entriesPerPage, page * s.entriesPerPage);
  }
  const ratings = await recordRatings(ctx, a, shown);
  return {
    fields,
    total,
    page,
    pageSize: s.entriesPerPage,
    missing,
    sort: sortField?.name ?? '',
    order: order === 1 ? ('asc' as const) : ('desc' as const),
    pendingCount: manage
      ? await ctx.db.dataRecord.count({ where: { activityId: a.id, approved: false } })
      : 0,
    files: Object.fromEntries(
      shown.flatMap((r) =>
        r.contents.filter((c) => files.has(c.value)).map((c) => [c.value, files.get(c.value)!]),
      ),
    ),
    items: shown.map((r) => ({
      id: r.id,
      user: r.user,
      approved: r.approved,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      values: valuesOf(r),
      canEdit: manage || (!!user && r.userId === user),
      canApprove: manage,
      rating: ratings.get(r.id) ?? null,
    })),
  };
}

async function recordRatings(
  ctx: ModuleCtx,
  a: Db,
  records: { id: string; userId: string | null; approved: boolean; createdAt: Date }[],
): Promise<Map<string, RecordRating>> {
  const s = a.settings;
  const out = new Map<string, RecordRating>();
  if (s.ratingAggregate === 'none' || !records.length) return out;
  const user = uid(ctx);
  const [rater, viewAll, view, scale] = await Promise.all([
    ctx.perm.can('mod.data:rate', a.id),
    ctx.perm.can('mod.data:viewallratings', a.id),
    ctx.perm.can('mod.data:viewrating', a.id),
    scaleItems(ctx.db, a.courseId, s.ratingScaleId),
  ]);
  const rows = await ctx.db.dataRating.findMany({
    where: { recordId: { in: records.map((r) => r.id) } },
    select: { recordId: true, raterId: true, value: true, rater: { select: { name: true } } },
  });
  for (const r of records) {
    const rs = rows.filter((x) => x.recordId === r.id);
    out.set(r.id, {
      aggregate:
        view || viewAll
          ? aggregateRatings(
              s.ratingAggregate,
              rs.map((x) => x.value),
              scale ? scale.length : s.ratingMax,
              !!scale,
            )
          : null,
      count: rs.length,
      mine: rs.find((x) => x.raterId === user)?.value ?? null,
      canRate:
        rater && r.approved && !!r.userId && r.userId !== user && inRatingWindow(r.createdAt, s),
      raters: viewAll ? rs.map((x) => ({ name: x.rater.name, value: x.value })) : [],
    });
  }
  return out;
}

/** A learner's grade: the aggregate of the ratings of their approved entries in the window. */
async function pushGrades(ctx: ModuleCtx, a: Db, userIds: (string | null)[]) {
  const s = a.settings;
  if (s.ratingAggregate === 'none') return;
  const scale = await scaleItems(ctx.db, a.courseId, s.ratingScaleId);
  const grades = [];
  for (const userId of new Set(userIds.filter((u): u is string => !!u))) {
    const rows = await ctx.db.dataRating.findMany({
      where: {
        record: {
          activityId: a.id,
          userId,
          approved: true,
          createdAt: {
            ...(s.ratingFrom ? { gte: new Date(s.ratingFrom) } : {}),
            ...(s.ratingTo ? { lte: new Date(s.ratingTo) } : {}),
          },
        },
      },
      select: { value: true },
    });
    grades.push({
      userId,
      itemNumber: 0,
      rawGrade: aggregateRatings(
        s.ratingAggregate,
        rows.map((x) => x.value),
        scale ? scale.length : s.ratingMax,
        !!scale,
      ),
    });
  }
  if (grades.length) await ctx.grades.setGrades(a.id, grades);
}

async function recordOf(ctx: ModuleCtx, a: ActivityRef, id: string) {
  const r = await ctx.db.dataRecord.findFirst({ where: { id, activityId: a.id } });
  if (!r) throw new ModuleError('NOT_FOUND', msg('mod.data.errors.noEntry'));
  return r;
}

async function mayChange(ctx: ModuleCtx, a: Db, authorId: string | null) {
  if (await ctx.perm.can('mod.data:manageentries', a.id)) return true;
  return !!authorId && authorId === uid(ctx);
}

/** Entries may be added between the dates; teachers add any time. */
async function checkOpen(ctx: ModuleCtx, a: Db) {
  if (await ctx.perm.can('mod.data:manageentries', a.id)) return;
  const s = a.settings;
  if (s.opensAt && ctx.now < new Date(s.opensAt))
    throw new ModuleError('BAD_REQUEST', msg('mod.data.errors.notOpenYet'));
  if (s.closesAt && ctx.now > new Date(s.closesAt))
    throw new ModuleError('BAD_REQUEST', msg('mod.data.errors.closed'));
}

/** Checks values against the fields; throws the first problem with the field's name. */
function checkValues(fields: Field[], values: Record<string, unknown>) {
  const out = new Map<string, string>();
  for (const f of fields) {
    if (fileTypes.includes(f.type)) continue;
    const c = cleanValue(f, values[f.id], sanitizeRichText);
    if ('error' in c)
      throw new ModuleError(
        'BAD_REQUEST',
        msg(`mod.data.errors.value.${c.error}`, { name: f.name }),
      );
    out.set(f.id, c.value);
  }
  return out;
}

async function writeContents(
  db: Prisma.TransactionClient,
  recordId: string,
  values: Map<string, string>,
) {
  for (const [fieldId, value] of values)
    await db.dataContent.upsert({
      where: { recordId_fieldId: { recordId, fieldId } },
      create: { recordId, fieldId, value },
      update: { value },
    });
}

const FileInput = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().default('application/octet-stream'),
  data: z.instanceof(Buffer),
});

/** Spreadsheet rows of the entries the user may see: a column per field, then who and when. */
export async function recordSheet(ctx: ModuleCtx, a: ActivityRef) {
  const r = await dataRecords(ctx, a, { all: true });
  const say = (key: string) => msg(`mod.data.sheet.${key}`).in(ctx.locale);
  const header = [...r.fields.map((f) => f.name), say('user'), say('added'), say('approved')];
  const fileOf = (id: string) => r.files[id];
  return [
    header,
    ...r.items.map((x) => [
      ...r.fields.map((f) => valueText(f, x.values[f.id] ?? '', fileOf)),
      x.user?.name ?? '',
      x.createdAt.toISOString(),
      x.approved ? say('yes') : say('no'),
    ]),
  ];
}

const ExportedField = z.object({
  type: z.enum(fieldTypes),
  name: z.string().max(255),
  description: z.string().max(2000),
  required: z.boolean(),
  options: z.object({
    choices: z.array(z.string().max(255)).optional(),
    linkText: z.string().optional(),
  }),
});

export const data = defineModule<DataSettingsT>({
  key: 'data',
  archetype: 'activity',
  icon: 'Database',
  supports: { viewCompletion: true, groups: true },
  settings: {
    schema: DataSettings as unknown as z.ZodType<DataSettingsT>,
    defaults: () => DataSettings.parse({}),
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
      entries: z.preprocess(
        (v) => (v === '' || v === null ? undefined : v),
        z.coerce.number().int().min(1).max(1000).optional(),
      ),
    }),
    async evaluate(ctx, a, userId, rules) {
      const need = (rules as { entries?: number }).entries;
      if (!need) return 'complete';
      const n = await ctx.db.dataRecord.count({
        where: { activityId: a.id, userId, approved: true },
      });
      return n >= need ? 'complete' : 'incomplete';
    },
  },
  // entries are what learners add: the tutor does not read them
  ai: { tutorPolicy: 'exclude' },
  files: {
    // a value's file: whoever may see its entry
    content: {
      async canRead(ctx, ref, f) {
        if (!f.itemId) return false;
        const a = ref as Db;
        const n = await ctx.db.dataRecord.count({
          where: { AND: [await visibleWhere(ctx, a), { id: f.itemId }] },
        });
        return n > 0;
      },
    },
  },
  lifecycle: {
    // new rating settings change every rating grade; the item comes and goes with them
    async onUpdate(ctx, ref, prev) {
      const a = ref as Db;
      const keys = [
        'ratingAggregate',
        'ratingScaleId',
        'ratingMax',
        'ratingFrom',
        'ratingTo',
      ] as const;
      if (!keys.some((k) => a.settings[k] !== prev[k])) return;
      await ctx.grades.syncItems(a.id);
      const authors = await ctx.db.dataRecord.findMany({
        where: { activityId: a.id, userId: { not: null } },
        select: { userId: true },
        distinct: ['userId'],
      });
      await pushGrades(
        ctx,
        a,
        authors.map((r) => r.userId),
      );
    },
  },
  reset: {
    async userData(ctx, a) {
      const files = await ctx.files.list(a.id, 'content');
      if (files.length)
        await ctx.files.remove(
          a.id,
          'content',
          files.map((f) => f.id),
        );
      await ctx.db.dataRecord.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return {
        entries: await ctx.db.dataRecord.findMany({
          where: { userId },
          select: {
            activityId: true,
            createdAt: true,
            contents: { select: { value: true, field: { select: { name: true } } } },
          },
        }),
        ratings: await ctx.db.dataRating.findMany({
          where: { raterId: userId },
          select: { recordId: true, value: true, createdAt: true },
        }),
      };
    },
    async erase(ctx, userId) {
      await ctx.db.dataRating.deleteMany({ where: { raterId: userId } });
      const records = await ctx.db.dataRecord.findMany({
        where: { userId },
        select: { id: true, activityId: true },
      });
      for (const r of records) {
        const files = await ctx.files.list(r.activityId, 'content', r.id);
        if (files.length)
          await ctx.files.remove(
            r.activityId,
            'content',
            files.map((f) => f.id),
            r.id,
          );
      }
      await ctx.db.dataRecord.deleteMany({ where: { userId } });
    },
  },
  backup: {
    userFileAreas: ['content'],
    // the fields (and templates in the settings) make the database; entries are users' data
    async export(ctx, a) {
      return {
        fields: (await dataFields(ctx.db, a.id)).map(({ id: _id, ...f }) => f),
      };
    },
    async import(ctx, a, raw) {
      const parsed = z.object({ fields: z.array(z.unknown()).max(500) }).safeParse(raw);
      if (!parsed.success) return;
      let n = 0;
      const taken = new Set<string>();
      for (const item of parsed.data.fields) {
        const f = ExportedField.safeParse(item);
        if (!f.success || taken.has(f.data.name)) continue;
        taken.add(f.data.name);
        const input = FieldInput.safeParse({
          name: f.data.name,
          description: f.data.description,
          required: f.data.required,
          choices: f.data.options.choices ?? [],
          linkText: f.data.options.linkText ?? '',
        });
        if (!input.success) continue;
        try {
          await ctx.db.dataField.create({
            data: {
              activityId: a.id,
              sortOrder: n++,
              type: f.data.type,
              ...fieldRow(f.data.type, input.data),
            },
          });
        } catch {
          // a field the database cannot take is left out
        }
      }
    },
  },
  queries: {
    fields: defineQuery({
      summary: 'The fields of the database, in order',
      input: z.object({}),
      async handler(ctx, a) {
        return dataFields(ctx.db, a.id);
      },
    }),
    entries: defineQuery({
      summary:
        'Entries you may see, a page at a time: `search` in every value, `sort` by a field name (time added by default)',
      input: z.object({
        search: z.string().max(200).optional(),
        sort: z.string().max(255).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        page: z.coerce.number().int().min(1).default(1),
      }),
      async handler(ctx, a, input) {
        const r = await dataRecords(ctx, a, input);
        return { ...r, fields: r.fields.map((f) => ({ id: f.id, name: f.name, type: f.type })) };
      },
    }),
  },
  actions: {
    // ── fields ──
    addField: defineAction({
      summary: 'Add a field (menus, radio buttons and checkboxes take their choices, one per line)',
      capability: 'mod.data:managefields',
      input: FieldInput.extend({ type: z.enum(fieldTypes) }),
      async handler(ctx, a, input) {
        const n = await ctx.db.dataField.count({ where: { activityId: a.id } });
        if (await ctx.db.dataField.findFirst({ where: { activityId: a.id, name: input.name } }))
          throw new ModuleError('CONFLICT', msg('mod.data.errors.fieldNameTaken'));
        const f = await ctx.db.dataField.create({
          data: {
            activityId: a.id,
            sortOrder: n,
            type: input.type,
            ...fieldRow(input.type, input),
          },
        });
        return { id: f.id };
      },
    }),
    updateField: defineAction({
      summary: 'Change a field (its kind stays; renaming does not change templates)',
      capability: 'mod.data:managefields',
      input: FieldInput.extend({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        const f = await ctx.db.dataField.findFirst({ where: { id: input.id, activityId: a.id } });
        if (!f) throw new ModuleError('NOT_FOUND', msg('mod.data.errors.noField'));
        const same = await ctx.db.dataField.findFirst({
          where: { activityId: a.id, name: input.name, id: { not: f.id } },
        });
        if (same) throw new ModuleError('CONFLICT', msg('mod.data.errors.fieldNameTaken'));
        await ctx.db.dataField.update({
          where: { id: f.id },
          data: fieldRow(f.type as FieldType, input),
        });
        return { id: f.id };
      },
    }),
    moveField: defineAction({
      summary: 'Move a field up or down',
      capability: 'mod.data:managefields',
      input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
      async handler(ctx, a, input) {
        const order = (await dataFields(ctx.db, a.id)).map((f) => f.id);
        const i = order.indexOf(input.id);
        if (i < 0) throw new ModuleError('NOT_FOUND', msg('mod.data.errors.noField'));
        const j = input.direction === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < order.length) {
          [order[i], order[j]] = [order[j]!, order[i]!];
          for (const [k, id] of order.entries())
            await ctx.db.dataField.update({ where: { id }, data: { sortOrder: k } });
        }
        return { ok: true };
      },
    }),
    deleteField: defineAction({
      summary: 'Delete a field with its values in every entry',
      capability: 'mod.data:managefields',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        const f = await ctx.db.dataField.findFirst({
          where: { id: input.id, activityId: a.id },
          include: { contents: { select: { value: true } } },
        });
        if (!f) throw new ModuleError('NOT_FOUND', msg('mod.data.errors.noField'));
        if (fileTypes.includes(f.type as FieldType)) {
          const ids = f.contents.map((c) => c.value).filter(Boolean);
          if (ids.length) await ctx.files.remove(a.id, 'content', ids);
        }
        await ctx.db.dataField.delete({ where: { id: f.id } });
        return { ok: true };
      },
    }),
    // ── entries ──
    saveEntry: defineAction({
      summary:
        'Add an entry, or change one (`id`): `values` by field id (a list for checkboxes); files with `fileFields` naming each file’s field',
      capability: 'mod.data:writeentry',
      input: z.object({
        id: z.string().uuid().optional(),
        values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
        files: z.array(FileInput).max(20).default([]),
        fileFields: z.array(z.string()).max(20).default([]),
        removeFiles: z.array(z.string()).max(20).default([]),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Db;
        const user = me(ctx);
        const manage = await ctx.perm.can('mod.data:manageentries', a.id);
        await checkOpen(ctx, a);
        const fields = await dataFields(ctx.db, a.id);
        if (!fields.length) throw new ModuleError('BAD_REQUEST', msg('mod.data.errors.noFields'));
        const values = checkValues(fields, input.values);
        let record = input.id ? await recordOf(ctx, a, input.id) : null;
        if (record && !(await mayChange(ctx, a, record.userId)))
          throw new ModuleError('FORBIDDEN', msg('mod.data.errors.cannotChange'));
        if (!record) {
          if (a.settings.maxEntries && !manage) {
            const n = await ctx.db.dataRecord.count({ where: { activityId: a.id, userId: user } });
            if (n >= a.settings.maxEntries)
              throw new ModuleError('CONFLICT', msg('mod.data.errors.entryLimit'));
          }
          const groups = a.groupMode === 'NONE' ? [] : await userGroupIds(ctx.db, a, user);
          record = await ctx.db.dataRecord.create({
            data: {
              activityId: a.id,
              userId: user,
              groupId: groups[0] ?? null,
              approved: manage || !a.settings.approvalRequired,
              createdAt: ctx.now,
            },
          });
        }
        await writeContents(ctx.db, record.id, values);
        // files: replace, add or remove a field's file
        const current = new Map(
          (await ctx.db.dataContent.findMany({ where: { recordId: record.id } })).map((c) => [
            c.fieldId,
            c.value,
          ]),
        );
        const uploaded = new Map<string, z.output<typeof FileInput>>();
        input.files.forEach((f, i) => {
          const fieldId = input.fileFields[i];
          if (fieldId) uploaded.set(fieldId, f);
        });
        for (const f of fields.filter((x) => fileTypes.includes(x.type))) {
          const file = uploaded.get(f.id);
          const old = current.get(f.id) ?? '';
          if (file) {
            if (f.type === 'image' && !file.mimeType.startsWith('image/'))
              throw new ModuleError(
                'BAD_REQUEST',
                msg('mod.data.errors.value.picture', { name: f.name }),
              );
            const stored = await ctx.files.store(
              a.id,
              'content',
              { ...file, itemId: record.id },
              { maxBytes: a.settings.maxFileMB * 1024 * 1024 },
            );
            if (old) await ctx.files.remove(a.id, 'content', [old], record.id);
            await writeContents(ctx.db, record.id, new Map([[f.id, stored.id]]));
          } else if (old && input.removeFiles.includes(f.id)) {
            await ctx.files.remove(a.id, 'content', [old], record.id);
            await writeContents(ctx.db, record.id, new Map([[f.id, '']]));
          }
          const now = (
            await ctx.db.dataContent.findUnique({
              where: { recordId_fieldId: { recordId: record.id, fieldId: f.id } },
            })
          )?.value;
          if (f.required && !now)
            throw new ModuleError(
              'BAD_REQUEST',
              msg('mod.data.errors.value.required', { name: f.name }),
            );
        }
        await ctx.db.dataRecord.update({ where: { id: record.id }, data: { updatedAt: ctx.now } });
        if (record.userId) await ctx.completion.recompute(a.id, record.userId);
        if (!input.id)
          await ctx.log('data.entry.created', { activityId: a.id, recordId: record.id });
        return { id: record.id, approved: record.approved };
      },
    }),
    deleteEntry: defineAction({
      summary: 'Delete an entry (yours, or any for teachers)',
      capability: 'mod.data:writeentry',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const a = ref as Db;
        const r = await recordOf(ctx, a, input.id);
        if (!(await mayChange(ctx, a, r.userId)))
          throw new ModuleError('FORBIDDEN', msg('mod.data.errors.cannotDelete'));
        const files = await ctx.files.list(a.id, 'content', r.id);
        if (files.length)
          await ctx.files.remove(
            a.id,
            'content',
            files.map((f) => f.id),
            r.id,
          );
        await ctx.db.dataRecord.delete({ where: { id: r.id } });
        await pushGrades(ctx, a, [r.userId]);
        if (r.userId) await ctx.completion.recompute(a.id, r.userId);
        return { ok: true };
      },
    }),
    approveEntry: defineAction({
      summary: 'Approve an entry, or take the approval back',
      capability: 'mod.data:manageentries',
      input: z.object({ id: z.string().uuid(), approved: z.boolean() }),
      async handler(ctx, ref, input) {
        const a = ref as Db;
        const r = await recordOf(ctx, a, input.id);
        await ctx.db.dataRecord.update({ where: { id: r.id }, data: { approved: input.approved } });
        await pushGrades(ctx, a, [r.userId]);
        if (r.userId) await ctx.completion.recompute(a.id, r.userId);
        return { ok: true };
      },
    }),
    rate: defineAction({
      summary:
        'Rate an entry (null takes your rating back): points 0..max, or a 1-based position on the scale',
      capability: 'mod.data:rate',
      input: z.object({ recordId: z.string().uuid(), value: z.number().int().nullable() }),
      async handler(ctx, ref, input) {
        const a = ref as Db;
        const user = me(ctx);
        if (a.settings.ratingAggregate === 'none')
          throw new ModuleError('CONFLICT', msg('mod.data.errors.ratingsOff'));
        const r = await recordOf(ctx, a, input.recordId);
        if (
          !r.approved ||
          !r.userId ||
          r.userId === user ||
          !inRatingWindow(r.createdAt, a.settings)
        )
          throw new ModuleError('FORBIDDEN', msg('mod.data.errors.cannotRate'));
        if (input.value === null)
          await ctx.db.dataRating.deleteMany({ where: { recordId: r.id, raterId: user } });
        else {
          const scale = await scaleItems(ctx.db, a.courseId, a.settings.ratingScaleId);
          const [lo, hi] = scale ? [1, scale.length] : [0, a.settings.ratingMax];
          if (input.value < lo || input.value > hi)
            throw new ModuleError('BAD_REQUEST', msg('mod.data.errors.ratingRange', { lo, hi }));
          await ctx.db.dataRating.upsert({
            where: { recordId_raterId: { recordId: r.id, raterId: user } },
            create: { recordId: r.id, raterId: user, value: input.value },
            update: { value: input.value },
          });
        }
        await pushGrades(ctx, a, [r.userId]);
        return { ok: true };
      },
    }),
    importCsv: defineAction({
      summary:
        'Add entries from CSV text whose header row names the fields (files and pictures are left out); yours, approved',
      capability: 'mod.data:manageentries',
      input: z.object({
        csv: z.string().max(5_000_000),
        /** The group the entries are of; none: seen by every group. */
        groupId: z.string().uuid().nullable().default(null),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Db;
        const user = me(ctx);
        if (
          input.groupId &&
          !(await ctx.db.group.count({ where: { id: input.groupId, ...groupsWhere(a) } }))
        )
          throw new ModuleError('BAD_REQUEST', msg('errors.common.unknownGroup'));
        const fields = await dataFields(ctx.db, a.id);
        const [header, ...rows] = parseCsv(input.csv);
        if (!header) throw new ModuleError('BAD_REQUEST', msg('mod.data.errors.fileEmpty'));
        const columns = header.map((h) => fields.find((f) => f.name === h.trim()));
        const unknown = header.filter((h, i) => h.trim() && !columns[i]);
        if (!columns.some(Boolean))
          throw new ModuleError('BAD_REQUEST', msg('mod.data.errors.noMatchingColumns'));
        const errors: { line: number; message: string }[] = [];
        let created = 0;
        for (const [i, row] of rows.entries()) {
          const raw: Record<string, string> = {};
          columns.forEach((f, k) => {
            if (f && !fileTypes.includes(f.type)) raw[f.id] = row[k] ?? '';
          });
          let values: Map<string, string>;
          try {
            values = checkValues(
              fields.filter((f) => !fileTypes.includes(f.type)),
              raw,
            );
          } catch (e) {
            errors.push({ line: i + 2, message: e instanceof Error ? e.message : String(e) });
            continue;
          }
          const record = await ctx.db.dataRecord.create({
            data: {
              activityId: a.id,
              userId: user,
              groupId: input.groupId,
              approved: true,
              createdAt: ctx.now,
            },
          });
          await writeContents(ctx.db, record.id, values);
          created++;
        }
        await ctx.log('data.entries.imported', { activityId: a.id, created });
        return { created, errors: errors.slice(0, 100), skippedColumns: unknown };
      },
    }),
  },
  async http(ctx, req, p) {
    // GET /api/mod/data/<activityId>/entries.(csv|xlsx)
    const [activityId, file] = p;
    const format = file === 'entries.csv' ? 'csv' : file === 'entries.xlsx' ? 'xlsx' : null;
    if (req.method !== 'GET' || !activityId || !format)
      return new Response('Not found', { status: 404 });
    const access = await ctx.activities.get(activityId);
    if (!access?.canOpen || !(await ctx.perm.can('mod.data:exportentries', activityId)))
      return new Response('Forbidden', { status: 403 });
    const rows = await recordSheet(ctx, access.activity);
    const headers = {
      'Content-Disposition': `attachment; filename="entries.${format}"`,
      'Cache-Control': 'private, no-store',
    };
    if (format === 'xlsx')
      return new Response(Buffer.from(writeXlsx(rows, 'Entries')), {
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

export const dataModules = [data];
