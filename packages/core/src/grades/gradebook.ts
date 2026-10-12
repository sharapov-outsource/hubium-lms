import type { Db, GradeCategory, GradeItem, Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { optionalText } from '../lib/zod.ts';
import { provideModuleServices, toActivityRef } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { defineOperation } from '../operation.ts';
import { parseCsv } from '../users/users.ts';
import { type Aggregation, aggregate, defaultLetters, type LetterBoundary } from './aggregate.ts';

type Tx = Prisma.TransactionClient | Db;

const num = (d: Prisma.Decimal | number | null | undefined): number | null =>
  d === null || d === undefined ? null : typeof d === 'number' ? d : d.toNumber();

/** Root category and course-total item, created on demand. */
export async function ensureCourseGradebook(
  tx: Tx,
  courseId: string,
): Promise<{ root: GradeCategory; total: GradeItem }> {
  let root = await tx.gradeCategory.findFirst({ where: { courseId, parentId: null } });
  root ??= await tx.gradeCategory.create({ data: { courseId, name: '', aggregation: 'NATURAL' } });
  let total = await tx.gradeItem.findFirst({ where: { courseId, kind: 'COURSE' } });
  total ??= await tx.gradeItem.create({
    data: {
      courseId,
      kind: 'COURSE',
      name: '',
      categoryId: root.id,
      gradeMax: 100,
      sortOrder: 1_000_000,
    },
  });
  return { root, total };
}

/** Creates/updates the activity's grade items from the module's grading spec. */
export async function syncGradeItemsFor(tx: Tx, activityId: string): Promise<void> {
  const a = await tx.activity.findUnique({ where: { id: activityId } });
  if (!a) return;
  const m = getModule(a.moduleKey);
  if (!m?.grading) return;
  const { root } = await ensureCourseGradebook(tx, a.courseId);
  const specs = m.grading.items(toActivityRef(a));
  const existing = await tx.gradeItem.findMany({ where: { activityId } });
  const count = await tx.gradeItem.count({ where: { courseId: a.courseId } });
  for (const [i, spec] of specs.entries()) {
    const cur = existing.find((x) => x.itemNumber === spec.itemNumber);
    const data = {
      name: specs.length > 1 ? `${a.name}: ${spec.name}` : a.name,
      gradeMax: spec.gradeMax,
      gradePass: spec.gradePass ?? null,
      hidden: a.visibility === 'HIDDEN' || !!a.deletedAt,
    };
    if (cur) await tx.gradeItem.update({ where: { id: cur.id }, data });
    else
      await tx.gradeItem.create({
        data: {
          ...data,
          courseId: a.courseId,
          categoryId: root.id,
          kind: 'MODULE',
          activityId,
          moduleKey: a.moduleKey,
          itemNumber: spec.itemNumber,
          sortOrder: count + i,
        },
      });
  }
  const keep = new Set(specs.map((s) => s.itemNumber));
  const stale = existing.filter((x) => !keep.has(x.itemNumber)).map((x) => x.id);
  if (stale.length) await tx.gradeItem.deleteMany({ where: { id: { in: stale } } });
}

async function writeGrade(
  tx: Tx,
  item: GradeItem,
  userId: string,
  values: {
    rawGrade?: number | null;
    finalGrade?: number | null;
    feedback?: string | null;
    overridden?: boolean;
  },
  meta: { source: string; changedById?: string | null },
) {
  const existing = await tx.grade.findUnique({
    where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
  });
  if (existing?.locked || item.locked) return existing;
  const raw = values.rawGrade === undefined ? num(existing?.rawGrade) : values.rawGrade;
  const overridden = values.overridden ?? existing?.overridden ?? false;
  const final =
    values.finalGrade !== undefined
      ? values.finalGrade
      : overridden
        ? num(existing?.finalGrade)
        : raw;
  const clamp = (v: number | null) =>
    v === null ? null : Math.min(num(item.gradeMax)!, Math.max(num(item.gradeMin)!, v));
  const data = {
    rawGrade: clamp(raw),
    finalGrade: clamp(final),
    feedback: values.feedback === undefined ? (existing?.feedback ?? null) : values.feedback,
    overridden,
    gradedById: meta.changedById ?? null,
    gradedAt: new Date(),
  };
  const g = existing
    ? await tx.grade.update({ where: { id: existing.id }, data })
    : await tx.grade.create({ data: { ...data, gradeItemId: item.id, userId } });
  await tx.gradeHistory.create({
    data: {
      gradeId: g.id,
      finalGrade: data.finalGrade,
      feedback: data.feedback,
      source: meta.source,
      changedById: meta.changedById ?? null,
    },
  });
  return g;
}

/** Recomputes the course total for the given users. */
export async function recomputeCourseTotals(
  tx: Tx,
  courseId: string,
  userIds: string[],
): Promise<void> {
  if (!userIds.length) return;
  const { total } = await ensureCourseGradebook(tx, courseId);
  const [categories, items, grades] = await Promise.all([
    tx.gradeCategory.findMany({ where: { courseId } }),
    tx.gradeItem.findMany({
      where: {
        courseId,
        kind: { in: ['MODULE', 'MANUAL'] },
        gradeType: { in: ['VALUE', 'SCALE'] },
      },
    }),
    tx.grade.findMany({
      where: { userId: { in: userIds }, item: { courseId, kind: { in: ['MODULE', 'MANUAL'] } } },
    }),
  ]);
  for (const userId of userIds) {
    const fraction = categoryFraction(
      null,
      categories,
      items,
      grades.filter((g) => g.userId === userId),
    );
    const value = fraction === null ? null : fraction * num(total.gradeMax)!;
    await writeGrade(tx, total, userId, { rawGrade: value }, { source: 'aggregation' });
  }
}

type GradeRow = { gradeItemId: string; finalGrade: Prisma.Decimal | null; excluded: boolean };

/** Fraction (0..1) of a category (null = root) for one user's grades. */
export function categoryFraction(
  categoryId: string | null,
  categories: Pick<
    GradeCategory,
    'id' | 'parentId' | 'aggregation' | 'dropLowest' | 'keepHighest' | 'aggregateOnlyGraded'
  >[],
  items: Pick<GradeItem, 'id' | 'categoryId' | 'gradeMin' | 'gradeMax' | 'weight'>[],
  grades: GradeRow[],
): number | null {
  const cat = categoryId
    ? categories.find((c) => c.id === categoryId)
    : categories.find((c) => !c.parentId);
  if (!cat) return null;
  const inputs = items
    .filter((i) => i.categoryId === cat.id || (!i.categoryId && !cat.parentId))
    .map((i) => {
      const g = grades.find((x) => x.gradeItemId === i.id);
      return {
        value: num(g?.finalGrade),
        min: num(i.gradeMin)!,
        max: num(i.gradeMax)!,
        weight: num(i.weight)!,
        excluded: g?.excluded,
      };
    });
  for (const child of categories.filter((c) => c.parentId === cat.id)) {
    const f = categoryFraction(child.id, categories, items, grades);
    inputs.push({
      value: f === null ? null : f * 100,
      min: 0,
      max: 100,
      weight: 1,
      excluded: false,
    });
  }
  return aggregate(inputs, {
    method: cat.aggregation as Aggregation,
    onlyGraded: cat.aggregateOnlyGraded,
    dropLowest: cat.dropLowest,
    keepHighest: cat.keepHighest,
  });
}

/** Module-facing grade writer (via ModuleCtx.grades.setGrades). */
export async function setActivityGrades(
  tx: Tx,
  activityId: string,
  grades: {
    userId: string;
    rawGrade: number | null;
    feedback?: string | null;
    itemNumber?: number;
    gradedById?: string | null;
  }[],
) {
  const a = await tx.activity.findUniqueOrThrow({
    where: { id: activityId },
    select: { courseId: true },
  });
  let items = await tx.gradeItem.findMany({ where: { activityId } });
  if (!items.length) {
    await syncGradeItemsFor(tx, activityId);
    items = await tx.gradeItem.findMany({ where: { activityId } });
  }
  for (const g of grades) {
    const item = items.find((i) => i.itemNumber === (g.itemNumber ?? 0));
    if (!item) continue;
    await writeGrade(
      tx,
      item,
      g.userId,
      { rawGrade: g.rawGrade, feedback: g.feedback },
      { source: 'module', changedById: g.gradedById },
    );
  }
  await recomputeCourseTotals(tx, a.courseId, [...new Set(grades.map((g) => g.userId))]);
}

provideModuleServices({
  setGrades: (_ctx, tx) => (activityId, grades) => setActivityGrades(tx, activityId, grades),
  syncGradeItems: (_ctx, tx) => (activityId) => syncGradeItemsFor(tx, activityId),
});

// ── teacher operations ────────────────────────────────────────────────────────

export const overrideGrade = defineOperation({
  name: 'grade.override',
  input: z.object({
    itemId: z.string().uuid(),
    userId: z.string().uuid(),
    value: z.union([z.number(), z.null()]),
    feedback: z.string().max(10_000).nullable().optional(),
  }),
  async authorize(ctx, i) {
    const item = await ctx.db.gradeItem.findUnique({ where: { id: i.itemId } });
    if (!item) throw new NotFoundError('Grade item');
    await ctx.perm.require('grade:edit', item.courseId);
  },
  async handler(ctx, { itemId, userId, value, feedback: rawFeedback }) {
    const feedback =
      rawFeedback === undefined || rawFeedback === null
        ? rawFeedback
        : sanitizeRichText(rawFeedback);
    const item = await ctx.tx.gradeItem.findUniqueOrThrow({ where: { id: itemId } });
    if (item.kind === 'COURSE' || item.kind === 'CATEGORY')
      throw new ValidationError({ itemId: ['Totals are calculated'] });
    if (value !== null && (value < num(item.gradeMin)! || value > num(item.gradeMax)!)) {
      throw new ValidationError({
        value: [`Grade must be between ${num(item.gradeMin)} and ${num(item.gradeMax)}`],
      });
    }
    const enrolled = await ctx.tx.enrolment.findFirst({
      where: { courseId: item.courseId, userId },
    });
    if (!enrolled) throw new ValidationError({ userId: ['User is not enrolled'] });
    if (item.kind === 'MANUAL') {
      await writeGrade(
        ctx.tx,
        item,
        userId,
        { rawGrade: value, feedback },
        { source: 'grader', changedById: ctx.perm.userId },
      );
    } else {
      // Overriding a module grade freezes it until the override is cleared (value null + clear).
      await writeGrade(
        ctx.tx,
        item,
        userId,
        { finalGrade: value, overridden: value !== null, feedback },
        { source: 'override', changedById: ctx.perm.userId },
      );
      if (value === null) {
        const g = await ctx.tx.grade.findUnique({
          where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
        });
        if (g)
          await ctx.tx.grade.update({
            where: { id: g.id },
            data: { finalGrade: g.rawGrade, overridden: false },
          });
      }
    }
    await recomputeCourseTotals(ctx.tx, item.courseId, [userId]);
    await logEvent(ctx.tx, {
      name: 'grade.updated',
      actorId: ctx.perm.userId,
      courseId: item.courseId,
      relatedUserId: userId,
      objectId: itemId,
      origin: ctx.origin,
    });
    return { ok: true };
  },
});

export const ManualItemInput = z.object({
  courseId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  categoryId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  gradeMax: z.coerce.number().positive().max(100_000).default(100),
  gradePass: z.coerce
    .number()
    .min(0)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  weight: z.coerce.number().min(0).max(1000).default(1),
  display: z.enum(['REAL', 'PERCENT', 'LETTER']).default('REAL'),
  idNumber: optionalText(100),
});

export const createManualItem = defineOperation({
  name: 'grade.item.create',
  input: ManualItemInput,
  authorize: (ctx, i) => ctx.perm.require('grade:manage', i.courseId),
  async handler(ctx, input) {
    const { root } = await ensureCourseGradebook(ctx.tx, input.courseId);
    const count = await ctx.tx.gradeItem.count({ where: { courseId: input.courseId } });
    const item = await ctx.tx.gradeItem.create({
      data: {
        courseId: input.courseId,
        categoryId: input.categoryId ?? root.id,
        kind: 'MANUAL',
        name: input.name,
        gradeMax: input.gradeMax,
        gradePass: input.gradePass ?? null,
        weight: input.weight,
        display: input.display,
        idNumber: input.idNumber,
        sortOrder: count,
      },
    });
    return { id: item.id };
  },
});

export const updateGradeItem = defineOperation({
  name: 'grade.item.update',
  input: z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(255).optional(),
    categoryId: z.string().uuid().optional(),
    weight: z.coerce.number().min(0).max(1000).optional(),
    gradePass: z.coerce.number().min(0).nullable().optional(),
    display: z.enum(['REAL', 'PERCENT', 'LETTER']).optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
  }),
  async authorize(ctx, i) {
    const item = await ctx.db.gradeItem.findUnique({ where: { id: i.id } });
    if (!item) throw new NotFoundError('Grade item');
    await ctx.perm.require('grade:manage', item.courseId);
  },
  async handler(ctx, { id, ...data }) {
    const item = await ctx.tx.gradeItem.findUniqueOrThrow({ where: { id } });
    if (item.kind === 'MODULE') delete data.name; // module items follow the activity name
    await ctx.tx.gradeItem.update({ where: { id }, data });
    const users = await ctx.tx.enrolment.findMany({
      where: { courseId: item.courseId },
      select: { userId: true },
    });
    await recomputeCourseTotals(ctx.tx, item.courseId, [...new Set(users.map((u) => u.userId))]);
    return { id };
  },
});

export const deleteManualItem = defineOperation({
  name: 'grade.item.delete',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const item = await ctx.db.gradeItem.findUnique({ where: { id: i.id } });
    if (!item) throw new NotFoundError('Grade item');
    if (item.kind !== 'MANUAL')
      throw new ValidationError({ id: ['Only manual items can be deleted'] });
    await ctx.perm.require('grade:manage', item.courseId);
  },
  async handler(ctx, { id }) {
    const item = await ctx.tx.gradeItem.delete({ where: { id } });
    const users = await ctx.tx.enrolment.findMany({
      where: { courseId: item.courseId },
      select: { userId: true },
    });
    await recomputeCourseTotals(ctx.tx, item.courseId, [...new Set(users.map((u) => u.userId))]);
    return { id };
  },
});

export const saveGradeCategory = defineOperation({
  name: 'grade.category.save',
  input: z.object({
    courseId: z.string().uuid(),
    id: z.string().uuid().optional(),
    name: z.string().trim().max(255).default(''),
    aggregation: z.enum(['NATURAL', 'MEAN', 'WEIGHTED_MEAN', 'HIGHEST', 'LOWEST', 'MEDIAN']),
    dropLowest: z.coerce.number().int().min(0).max(100).default(0),
    aggregateOnlyGraded: z.boolean().default(true),
  }),
  authorize: (ctx, i) => ctx.perm.require('grade:manage', i.courseId),
  async handler(ctx, input) {
    const { root } = await ensureCourseGradebook(ctx.tx, input.courseId);
    const data = {
      name: input.name,
      aggregation: input.aggregation,
      dropLowest: input.dropLowest,
      aggregateOnlyGraded: input.aggregateOnlyGraded,
    };
    const cat = input.id
      ? await ctx.tx.gradeCategory.update({ where: { id: input.id }, data })
      : await ctx.tx.gradeCategory.create({
          data: { ...data, courseId: input.courseId, parentId: root.id },
        });
    const users = await ctx.tx.enrolment.findMany({
      where: { courseId: input.courseId },
      select: { userId: true },
    });
    await recomputeCourseTotals(ctx.tx, input.courseId, [...new Set(users.map((u) => u.userId))]);
    return { id: cat.id };
  },
});

// ── reports ───────────────────────────────────────────────────────────────────

export async function courseLetters(
  db: Tx,
  courseId: string,
  locale: 'ru' | 'en',
): Promise<LetterBoundary[]> {
  const rows = await db.gradeLetter.findMany({ where: { contextId: courseId } });
  return rows.length
    ? rows.map((r) => ({ lowerBound: num(r.lowerBound)!, letter: r.letter }))
    : defaultLetters[locale];
}

export async function gradebookStructure(db: Tx, courseId: string) {
  await ensureCourseGradebook(db, courseId);
  const [categories, items] = await Promise.all([
    db.gradeCategory.findMany({
      where: { courseId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    db.gradeItem.findMany({
      where: { courseId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        scale: true,
        activity: { select: { deletedAt: true, visibility: true, moduleKey: true } },
      },
    }),
  ]);
  return { categories, items: items.filter((i) => !i.activity?.deletedAt) };
}

/** Grader report: every learner × every item, plus the course total. */
export async function graderReport(
  ctx: RequestContext,
  courseId: string,
  opts: { groupId?: string } = {},
) {
  await ctx.perm.require('grade:viewall', courseId);
  const { categories, items } = await gradebookStructure(ctx.db, courseId);
  const student = await ctx.db.role.findUnique({ where: { shortName: 'student' } });
  const users = await ctx.db.user.findMany({
    where: {
      deletedAt: null,
      enrolments: { some: { courseId } },
      roleAssignments: { some: { contextId: courseId, roleId: student?.id } },
      ...(opts.groupId ? { groupMembers: { some: { groupId: opts.groupId } } } : {}),
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: { id: true, name: true, email: true, username: true, emailPlaceholder: true },
  });
  const grades = await ctx.db.grade.findMany({
    where: { item: { courseId }, userId: { in: users.map((u) => u.id) } },
  });
  const cell = new Map(grades.map((g) => [`${g.userId}:${g.gradeItemId}`, g]));
  return { categories, items, users, cell };
}

/** A learner's own grades; hidden items are left out for learners. */
export async function userReport(ctx: RequestContext, courseId: string, userId: string) {
  const self = ctx.perm.userId === userId;
  if (!self) await ctx.perm.require('grade:viewall', courseId);
  else if (
    !(await ctx.perm.can('grade:view', courseId)) &&
    !(await ctx.perm.can('grade:viewall', courseId))
  ) {
    throw new ForbiddenError();
  }
  const { categories, items } = await gradebookStructure(ctx.db, courseId);
  const now = new Date();
  const visible =
    self && !(await ctx.perm.can('grade:viewall', courseId))
      ? items.filter(
          (i) =>
            !i.hidden &&
            (!i.hiddenUntil || i.hiddenUntil <= now) &&
            i.activity?.visibility !== 'HIDDEN',
        )
      : items;
  const grades = await ctx.db.grade.findMany({
    where: { userId, gradeItemId: { in: visible.map((i) => i.id) } },
  });
  return { categories, items: visible, grades: new Map(grades.map((g) => [g.gradeItemId, g])) };
}

export function csvEscape(v: string): string {
  return /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export async function exportGradesCsv(ctx: RequestContext, courseId: string): Promise<string> {
  await ctx.perm.require('grade:export', courseId);
  const r = await graderReport(ctx, courseId);
  const items = r.items.filter((i) => i.kind !== 'CATEGORY');
  const header = [
    'firstname lastname',
    'email',
    'username',
    ...items.map((i) => (i.kind === 'COURSE' ? 'Course total' : i.name)),
  ];
  const lines = [header.map(csvEscape).join(',')];
  for (const u of r.users) {
    const row = [
      u.name,
      u.emailPlaceholder ? '' : u.email,
      u.username ?? '',
      ...items.map((i) => {
        const v = num(r.cell.get(`${u.id}:${i.id}`)?.finalGrade);
        return v === null ? '' : String(Math.round(v * 100) / 100);
      }),
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Imports grades for MANUAL items by column name; users matched by email or username. */
export const importGradesCsv = defineOperation({
  name: 'grade.import',
  input: z.object({ courseId: z.string().uuid(), csv: z.string().min(1).max(5_000_000) }),
  authorize: (ctx, i) => ctx.perm.require('grade:import', i.courseId),
  async handler(ctx, { courseId, csv }) {
    const rows = parseCsv(csv);
    const header = rows.shift() ?? [];
    const idx = (n: string) => header.findIndex((h) => h.trim().toLowerCase() === n);
    const emailCol = idx('email');
    const userCol = idx('username');
    if (emailCol < 0 && userCol < 0)
      throw new ValidationError({ csv: ['Header must contain email or username'] });
    const items = await ctx.tx.gradeItem.findMany({ where: { courseId, kind: 'MANUAL' } });
    const cols = header
      .map((h, i) => ({
        i,
        item: items.find((it) => it.name.toLowerCase() === h.trim().toLowerCase()),
      }))
      .filter((c): c is { i: number; item: GradeItem } => !!c.item);
    if (!cols.length) throw new ValidationError({ csv: ['No columns match manual grade items'] });
    const errors: { line: number; message: string }[] = [];
    let updated = 0;
    const touched = new Set<string>();
    for (const [n, r] of rows.entries()) {
      const key = (emailCol >= 0 ? r[emailCol] : r[userCol])?.trim().toLowerCase();
      const user = key
        ? await ctx.tx.user.findFirst({
            where: { OR: [{ email: key }, { username: key }], enrolments: { some: { courseId } } },
          })
        : null;
      if (!user) {
        errors.push({ line: n + 2, message: `User not found: ${key ?? ''}` });
        continue;
      }
      for (const c of cols) {
        const raw = (r[c.i] ?? '').trim().replace(',', '.');
        if (raw === '') continue;
        const v = Number(raw);
        if (Number.isNaN(v) || v < num(c.item.gradeMin)! || v > num(c.item.gradeMax)!) {
          errors.push({ line: n + 2, message: `${c.item.name}: invalid grade ${raw}` });
          continue;
        }
        await writeGrade(
          ctx.tx,
          c.item,
          user.id,
          { rawGrade: v },
          { source: 'import', changedById: ctx.perm.userId },
        );
        updated++;
        touched.add(user.id);
      }
    }
    await recomputeCourseTotals(ctx.tx, courseId, [...touched]);
    return { updated, errors };
  },
});

export { num as decimalToNumber };
