import { type Db, type GradeCategory, type GradeItem, Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { isLocale } from '@hubium/i18n';
import { createTranslator } from '@hubium/i18n/packs';
import { msg } from '@hubium/module-sdk';
import { csvFile } from '@hubium/module-sdk/csv';
import { z } from 'zod';
import { usersWithCap } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { separateGroupsOf } from '../groups/visibility.ts';
import { enqueue } from '../jobs/jobs.ts';
import { writeOds } from '../lib/sheets.ts';
import { writeXlsx } from '../lib/xlsx.ts';
import { optionalText } from '../lib/zod.ts';
import { provideModuleServices, toActivityRef } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings, siteLocale } from '../settings/settings.ts';
import { isMentorOf, learnerPermissions } from '../users/mentors.ts';
import { emitWebhook } from '../webhooks/events.ts';
import { type Aggregation, aggregate } from './aggregate.ts';
import {
  CalculationError,
  calculate,
  calculationOrder,
  calculationRefs,
  displayCalculation,
  storeCalculation,
} from './calculation.ts';
import { requireScaleFor } from './scales.ts';

type Tx = Prisma.TransactionClient | Db;

const num = (d: Prisma.Decimal | number | null | undefined): number | null =>
  d === null || d === undefined ? null : typeof d === 'number' ? d : d.toNumber();

/** Root category and course-total item, created on demand. */
export async function ensureCourseGradebook(
  tx: Tx,
  courseId: string,
): Promise<{ root: GradeCategory; total: GradeItem }> {
  const find = () =>
    Promise.all([
      tx.gradeCategory.findFirst({ where: { courseId, parentId: null } }),
      tx.gradeItem.findFirst({ where: { courseId, kind: 'COURSE' } }),
    ]);
  let [root, total] = await find();
  if (root && total) return { root, total };
  // First grades of a course can arrive in parallel (two quiz attempts finishing): only
  // one transaction may create the root category and the total.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gradebook:${courseId}`}))`;
  [root, total] = await find();
  root ??= await tx.gradeCategory.create({ data: { courseId, name: '', aggregation: 'NATURAL' } });
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
  // items named by message keys are named in the course's language, or the site's
  const t = specs.some((s) => s.nameKey) ? await itemNameTranslator(tx, a.courseId) : null;
  const count = await tx.gradeItem.count({ where: { courseId: a.courseId } });
  // Totals depend on maxima and on which items count (deleted activities do not).
  let totalsChanged = false;
  for (const [i, spec] of specs.entries()) {
    const cur = existing.find((x) => x.itemNumber === spec.itemNumber);
    // A scale that is not (or no longer) available grades by points.
    const scale = spec.scaleId
      ? await tx.scale.findFirst({
          where: { id: spec.scaleId, OR: [{ courseId: null }, { courseId: a.courseId }] },
        })
      : null;
    // the first item carries the activity's ID number (when no other item has it)
    const idNumber = spec.itemNumber === 0 ? await activityIdNumber(tx, a, cur?.id) : undefined;
    const data = {
      ...(idNumber !== undefined ? { idNumber } : {}),
      name:
        specs.length > 1 ? `${a.name}: ${spec.nameKey && t ? t(spec.nameKey) : spec.name}` : a.name,
      gradeType: scale ? ('SCALE' as const) : ('VALUE' as const),
      scaleId: scale?.id ?? null,
      gradeMin: scale ? 1 : 0,
      gradeMax: scale ? scale.items.length : spec.gradeMax,
      gradePass: spec.gradePass ?? null,
    };
    // `hidden` is the teacher's choice in the gradebook; a hidden activity hides its items
    // by itself (see hiddenFromLearner), so a sync never touches the flag
    if (cur && (num(cur.gradeMax) !== data.gradeMax || num(cur.gradeMin) !== data.gradeMin))
      totalsChanged = true;
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
  if (totalsChanged || stale.length) await recomputeAllTotals(tx, a.courseId);
}

/** The activity's ID number for its first grade item, unless something else has it. */
async function activityIdNumber(
  tx: Tx,
  a: { courseId: string; idNumber: string | null },
  itemId: string | undefined,
) {
  if (!a.idNumber) return null;
  const where = {
    courseId: a.courseId,
    idNumber: { equals: a.idNumber, mode: 'insensitive' as const },
  };
  const [item, cat] = await Promise.all([
    tx.gradeItem.findFirst({ where: { ...where, ...(itemId ? { id: { not: itemId } } : {}) } }),
    tx.gradeCategory.findFirst({ where }),
  ]);
  return item || cat ? undefined : a.idNumber;
}

async function itemNameTranslator(tx: Tx, courseId: string) {
  const [course, settings] = await Promise.all([
    tx.course.findUnique({ where: { id: courseId }, select: { lang: true } }),
    getAllSettings(tx),
  ]);
  const site = siteLocale(settings);
  return createTranslator(isLocale(course?.lang) ? course.lang : site, site);
}

/** Course totals of everyone enrolled (after a change to the gradebook structure). */
export async function recomputeAllTotals(tx: Tx, courseId: string): Promise<void> {
  const users = await tx.enrolment.findMany({
    where: { courseId },
    select: { userId: true },
    distinct: ['userId'],
  });
  await recomputeTotalsOf(
    tx,
    courseId,
    users.map((u) => u.userId),
  );
}

/** Worker job: everyone's totals in a course, a batch at a time (see recalcCourseTotals). */
export const GRADES_RECALC_JOB = 'grades.recalc.course';
/** Up to this many people the totals are worked out at once, in the change's transaction. */
const TOTALS_AT_ONCE = 200;

/**
 * Totals of these people after a change: at once for a few, by the worker for more (a
 * change of the course's categories, items or formulas touches everyone, and thousands
 * in one transaction would outlast it). The worker's run covers the whole course.
 */
export async function recomputeTotalsOf(tx: Tx, courseId: string, userIds: string[]) {
  if (userIds.length <= TOTALS_AT_ONCE) return recomputeCourseTotals(tx, courseId, userIds);
  await enqueue(
    GRADES_RECALC_JOB,
    { courseId },
    {
      tx: tx as Prisma.TransactionClient,
      singletonKey: courseId,
      singletonSeconds: 30,
      singletonNextSlot: true,
    },
  );
}

/** The worker's part: everyone enrolled, TOTALS_AT_ONCE people to a transaction. */
export async function recalcCourseTotals(db: Db, courseId: string): Promise<number> {
  const users = (
    await db.enrolment.findMany({
      where: { courseId },
      select: { userId: true },
      distinct: ['userId'],
    })
  ).map((u) => u.userId);
  for (let i = 0; i < users.length; i += TOTALS_AT_ONCE)
    await db.$transaction(
      (tx) => recomputeCourseTotals(tx, courseId, users.slice(i, i + TOTALS_AT_ONCE)),
      { timeout: 60_000 },
    );
  return users.length;
}

/** Writes one grade (respecting locks and overrides) and records it in the history. */
/** A locked item or grade keeps its value: writeGrade leaves it as it is. */
export async function gradeLocked(
  tx: Tx,
  item: Pick<GradeItem, 'id' | 'locked'>,
  userId: string,
): Promise<boolean> {
  if (item.locked) return true;
  const g = await tx.grade.findUnique({
    where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
    select: { locked: true },
  });
  return !!g?.locked;
}

export async function writeGrade(
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
  // No grade yet and none to give (a total with nothing to total): no empty row, history
  // or grade.updated with a null grade for everyone.
  if (
    !existing &&
    data.rawGrade === null &&
    data.finalGrade === null &&
    !data.feedback &&
    !overridden
  )
    return null;
  // Nothing changed (totals are recomputed often): no write, no history, no webhook.
  if (
    existing &&
    num(existing.rawGrade) === data.rawGrade &&
    num(existing.finalGrade) === data.finalGrade &&
    (existing.feedback ?? null) === data.feedback &&
    existing.overridden === data.overridden
  )
    return existing;
  const g = existing
    ? await tx.grade.update({ where: { id: existing.id }, data })
    : await tx.grade.create({ data: { ...data, gradeItemId: item.id, userId } });
  if (!existing || num(existing.finalGrade) !== data.finalGrade)
    await emitWebhook(tx, 'grade.updated', {
      userId,
      courseId: item.courseId,
      activityId: item.activityId,
      actorId: meta.changedById ?? null,
      extra: {
        gradeItem: { id: item.id, name: item.name, kind: item.kind, gradeMax: num(item.gradeMax) },
        grade: data.finalGrade,
      },
    });
  await tx.gradeHistory.create({
    data: {
      gradeId: g.id,
      previousGrade: existing ? num(existing.finalGrade) : null,
      finalGrade: data.finalGrade,
      overridden: data.overridden,
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
  // One recompute per person at a time, until the transaction ends: another one, running
  // with a grade of its own, would work out the total without this transaction's grade and
  // write it over (or both would create the total row). Taken in one order, so two
  // recomputes of several people cannot wait on each other.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`grades:${courseId}:`} || u, 0))
      FROM unnest(${[...new Set(userIds)].sort()}::text[]) AS u ORDER BY u`;
  const [categories, items, grades] = await Promise.all([
    tx.gradeCategory.findMany({ where: { courseId } }),
    tx.gradeItem.findMany({
      where: {
        courseId,
        kind: { in: ['MODULE', 'MANUAL'] },
        gradeType: { in: ['VALUE', 'SCALE'] },
        // activities in the recycle bin do not count
        OR: [{ activityId: null }, { activity: { deletedAt: null } }],
      },
    }),
    tx.grade.findMany({
      where: {
        userId: { in: userIds },
        item: {
          courseId,
          kind: { in: ['MODULE', 'MANUAL'] },
          OR: [{ activityId: null }, { activity: { deletedAt: null } }],
        },
      },
    }),
  ]);
  const calculated = await calculationPlan(tx, categories, items);
  const byUser = new Map<string, GradeRow[]>();
  for (const g of grades) {
    const list = byUser.get(g.userId);
    if (list) list.push(g);
    else byUser.set(g.userId, [g]);
  }
  for (const userId of userIds) {
    const mine: GradeRow[] = byUser.get(userId) ?? [];
    // calculated items first, each after what it uses, then the total over everything
    for (const item of calculated) {
      const value = calculate(item.calculation!, (r) => {
        if (r.kind === 'item') {
          if (!items.some((i) => i.id === r.id)) return undefined;
          return num(mine.find((g) => g.gradeItemId === r.id)?.finalGrade);
        }
        const cat = categories.find((c) => c.id === r.id);
        if (!cat) return undefined;
        const f = categoryFraction(cat.id, categories, items, mine);
        return f === null ? null : f * categoryPoints(cat, categories, items);
      });
      const g = await writeGrade(tx, item, userId, { rawGrade: value }, { source: 'calculation' });
      const row = mine.find((x) => x.gradeItemId === item.id);
      if (row) row.finalGrade = g?.finalGrade ?? null;
      else if (g)
        mine.push({ gradeItemId: item.id, finalGrade: g.finalGrade, excluded: g.excluded });
    }
    const fraction = categoryFraction(null, categories, items, mine);
    const value = fraction === null ? null : fraction * num(total.gradeMax)!;
    await writeGrade(tx, total, userId, { rawGrade: value }, { source: 'aggregation' });
  }
}

/**
 * The course's calculated items in the order to compute them. Items whose formula uses
 * something no longer there (an activity removed, say) get `needsUpdate`, shown as a
 * warning in the gradebook setup; a formula that cannot be ordered is left out.
 */
async function calculationPlan(
  tx: Tx,
  categories: GradeCategory[],
  items: GradeItem[],
): Promise<GradeItem[]> {
  const calc = items.filter((i) => i.calculation);
  if (!calc.length) return [];
  for (const item of calc) {
    const r = calculationRefs(item.calculation!);
    const broken =
      r.items.some((id) => !items.some((i) => i.id === id)) ||
      r.categories.some((id) => !categories.some((c) => c.id === id));
    if (broken !== item.needsUpdate)
      await tx.gradeItem.update({ where: { id: item.id }, data: { needsUpdate: broken } });
  }
  try {
    return calculationOrder(items, categories).map((id) => calc.find((i) => i.id === id)!);
  } catch (e) {
    if (e instanceof CalculationError) return [];
    throw e;
  }
}

type GradeRow = { gradeItemId: string; finalGrade: Prisma.Decimal | null; excluded: boolean };
type TreeCategory = Pick<
  GradeCategory,
  'id' | 'parentId' | 'aggregation' | 'dropLowest' | 'keepHighest' | 'aggregateOnlyGraded'
> & { weight?: GradeCategory['weight'] | number };
type TreeItem = Pick<GradeItem, 'id' | 'categoryId' | 'gradeMin' | 'gradeMax' | 'weight'>;

function itemsOf(cat: TreeCategory, items: TreeItem[]) {
  return items.filter((i) => i.categoryId === cat.id || (!i.categoryId && !cat.parentId));
}

/**
 * Points a category is worth inside its parent: with natural aggregation the sum of what
 * it contains (as in Moodle), otherwise 100.
 */
export function categoryPoints(
  cat: TreeCategory,
  categories: TreeCategory[],
  items: TreeItem[],
): number {
  if (cat.aggregation !== 'NATURAL') return 100;
  const own = itemsOf(cat, items).reduce((s, i) => s + (num(i.gradeMax)! - num(i.gradeMin)!), 0);
  return categories
    .filter((c) => c.parentId === cat.id)
    .reduce((s, c) => s + categoryPoints(c, categories, items), own);
}

/** Fraction (0..1) of a category (null = root) for one user's grades. */
export function categoryFraction(
  categoryId: string | null,
  categories: TreeCategory[],
  items: TreeItem[],
  grades: GradeRow[],
): number | null {
  const cat = categoryId
    ? categories.find((c) => c.id === categoryId)
    : categories.find((c) => !c.parentId);
  if (!cat) return null;
  const inputs = itemsOf(cat, items).map((i) => {
    const g = grades.find((x) => x.gradeItemId === i.id);
    return {
      value: num(g?.finalGrade),
      min: num(i.gradeMin)!,
      max: num(i.gradeMax)!,
      weight: num(i.weight)!,
      excluded: g?.excluded,
    };
  });
  // A subcategory counts like an item worth its points, with its own weight.
  for (const child of categories.filter((c) => c.parentId === cat.id)) {
    const f = categoryFraction(child.id, categories, items, grades);
    const points = categoryPoints(child, categories, items);
    inputs.push({
      value: f === null ? null : f * points,
      min: 0,
      max: points,
      weight: num(child.weight as never) ?? 1,
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

/** Every category's fraction (0..1) for one user: the totals shown in the grader report. */
export function categoryFractions(
  categories: TreeCategory[],
  items: TreeItem[],
  grades: GradeRow[],
): Map<string, number | null> {
  return new Map(categories.map((c) => [c.id, categoryFraction(c.id, categories, items, grades)]));
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
    // Feedback is rendered as HTML in the gradebook: never trust a module (or the
    // external tool behind it) to have sanitised it.
    if (g.feedback) g.feedback = sanitizeRichText(g.feedback);
    await writeGrade(
      tx,
      item,
      g.userId,
      { rawGrade: g.rawGrade, feedback: g.feedback },
      { source: 'module', changedById: g.gradedById },
    );
  }
  await recomputeTotalsOf(tx, a.courseId, [...new Set(grades.map((g) => g.userId))]);
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
      throw new ValidationError({ itemId: [msg('errors.grades.totalsCalculated')] });
    if (value !== null && (value < num(item.gradeMin)! || value > num(item.gradeMax)!)) {
      throw new ValidationError({
        value: [
          msg('errors.grades.outOfRange', { min: num(item.gradeMin), max: num(item.gradeMax) }),
        ],
      });
    }
    if (value !== null && item.gradeType === 'SCALE' && !Number.isInteger(value))
      throw new ValidationError({ value: [msg('errors.grades.chooseGradeScale')] });
    const enrolled = await ctx.tx.enrolment.findFirst({
      where: { courseId: item.courseId, userId },
    });
    if (!enrolled) throw new ValidationError({ userId: [msg('errors.common.notEnrolled')] });
    // said, rather than answered "saved" with the grade unchanged
    if (await gradeLocked(ctx.tx, item, userId))
      throw new ValidationError({ value: [msg('errors.grades.gradeLocked')] });
    if (item.kind === 'MANUAL' && !item.calculation) {
      await writeGrade(
        ctx.tx,
        item,
        userId,
        { rawGrade: value, feedback },
        { source: 'grader', changedById: ctx.perm.userId },
      );
    } else {
      // Overriding a module grade (or a calculated one) freezes it; clearing it (null) brings
      // back the module's grade (or the formula's).
      await writeGrade(
        ctx.tx,
        item,
        userId,
        value === null
          ? { overridden: false, feedback }
          : { finalGrade: value, overridden: true, feedback },
        { source: 'override', changedById: ctx.perm.userId },
      );
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

/** ID numbers name items and categories in formulas: one per course across both. */
async function requireFreeIdNumber(
  tx: Tx,
  courseId: string,
  idNumber: string | null | undefined,
  except: { itemId?: string; categoryId?: string } = {},
) {
  if (!idNumber) return;
  const [item, cat] = await Promise.all([
    tx.gradeItem.findFirst({
      where: {
        courseId,
        idNumber: { equals: idNumber, mode: 'insensitive' },
        ...(except.itemId ? { id: { not: except.itemId } } : {}),
      },
    }),
    tx.gradeCategory.findFirst({
      where: {
        courseId,
        idNumber: { equals: idNumber, mode: 'insensitive' },
        ...(except.categoryId ? { id: { not: except.categoryId } } : {}),
      },
    }),
  ]);
  if (item || cat) throw new ValidationError({ idNumber: [msg('errors.grades.idNumberInUse')] });
}

/** Names of the items whose formulas use an item or a category. */
async function formulasUsing(
  tx: Tx,
  courseId: string,
  ref: { itemId?: string; categoryId?: string },
) {
  const token = ref.itemId ? `##gi${ref.itemId}##` : `##gc${ref.categoryId}##`;
  const rows = await tx.gradeItem.findMany({
    where: { courseId, calculation: { contains: token } },
    select: { name: true },
  });
  return rows.map((r) => r.name);
}

/**
 * An activity's ID number names its first grade item in formulas: it must be free in the
 * course's gradebook (its own item aside), and stay while formulas use the item.
 */
export async function requireActivityIdNumber(
  tx: Tx,
  courseId: string,
  idNumber: string | null | undefined,
  activityId?: string,
) {
  const own = activityId
    ? await tx.gradeItem.findFirst({ where: { activityId, itemNumber: 0 }, select: { id: true } })
    : null;
  if (!idNumber) {
    if (own && (await formulasUsing(tx, courseId, { itemId: own.id })).length)
      throw new ValidationError({
        idNumber: [msg('errors.grades.activityNeedsIdNumber')],
      });
    return;
  }
  await requireFreeIdNumber(tx, courseId, idNumber, { itemId: own?.id });
}

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
  /** Grade on this scale instead of points. */
  scaleId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/** A pass mark above the maximum could never be reached. */
function requirePassWithin(gradePass: number | null | undefined, gradeMax: number) {
  if (gradePass != null && gradePass > gradeMax)
    throw new ValidationError({ gradePass: [msg('errors.grades.passAboveMax')] });
}

/** Grade categories are addressed by id from forms: they must belong to the same course. */
async function requireGradeCategory(tx: Tx, courseId: string, categoryId: string) {
  const c = await tx.gradeCategory.findFirst({ where: { id: categoryId, courseId } });
  if (!c) throw new NotFoundError('Grade category');
  return c;
}

export const createManualItem = defineOperation({
  name: 'grade.item.create',
  input: ManualItemInput,
  authorize: (ctx, i) => ctx.perm.require('grade:manage', i.courseId),
  async handler(ctx, input) {
    const { root } = await ensureCourseGradebook(ctx.tx, input.courseId);
    if (input.categoryId) await requireGradeCategory(ctx.tx, input.courseId, input.categoryId);
    const scale = input.scaleId
      ? await requireScaleFor(ctx.tx, input.courseId, input.scaleId)
      : null;
    await requireFreeIdNumber(ctx.tx, input.courseId, input.idNumber);
    requirePassWithin(input.gradePass, scale ? scale.items.length : input.gradeMax);
    const count = await ctx.tx.gradeItem.count({ where: { courseId: input.courseId } });
    const item = await ctx.tx.gradeItem.create({
      data: {
        courseId: input.courseId,
        categoryId: input.categoryId ?? root.id,
        kind: 'MANUAL',
        name: input.name,
        gradeType: scale ? 'SCALE' : 'VALUE',
        scaleId: scale?.id ?? null,
        gradeMin: scale ? 1 : 0,
        gradeMax: scale ? scale.items.length : input.gradeMax,
        gradePass: input.gradePass ?? null,
        weight: input.weight,
        display: scale ? 'REAL' : input.display,
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
    /** The item in formulas; an activity's first item shares it with the activity. */
    idNumber: z
      .string()
      .trim()
      .max(100)
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v)),
  }),
  async authorize(ctx, i) {
    const item = await ctx.db.gradeItem.findUnique({ where: { id: i.id } });
    if (!item) throw new NotFoundError('Grade item');
    await ctx.perm.require('grade:manage', item.courseId);
  },
  async handler(ctx, { id, ...data }) {
    const item = await ctx.tx.gradeItem.findUniqueOrThrow({ where: { id } });
    if (item.kind === 'MODULE') delete data.name; // module items follow the activity name
    if (data.categoryId) await requireGradeCategory(ctx.tx, item.courseId, data.categoryId);
    requirePassWithin(data.gradePass, num(item.gradeMax)!);
    if (data.idNumber !== undefined && data.idNumber !== item.idNumber) {
      if (
        data.idNumber === null &&
        (await formulasUsing(ctx.tx, item.courseId, { itemId: id })).length
      )
        throw new ValidationError({ idNumber: [msg('errors.grades.itemNeedsIdNumber')] });
      await requireFreeIdNumber(ctx.tx, item.courseId, data.idNumber, { itemId: id });
      if (item.kind === 'MODULE' && item.itemNumber === 0 && item.activityId)
        await ctx.tx.activity.update({
          where: { id: item.activityId },
          data: { idNumber: data.idNumber },
        });
    }
    // a formula's item belongs where it does not use itself
    if (data.categoryId && item.calculation) {
      const [categories, items] = await Promise.all([
        ctx.tx.gradeCategory.findMany({ where: { courseId: item.courseId } }),
        ctx.tx.gradeItem.findMany({ where: { courseId: item.courseId } }),
      ]);
      requireOrder(
        items.map((i) => (i.id === id ? { ...i, categoryId: data.categoryId! } : i)),
        categories,
      );
    }
    await ctx.tx.gradeItem.update({ where: { id }, data });
    const users = await ctx.tx.enrolment.findMany({
      where: { courseId: item.courseId },
      select: { userId: true },
    });
    await recomputeTotalsOf(ctx.tx, item.courseId, [...new Set(users.map((u) => u.userId))]);
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
      throw new ValidationError({ id: [msg('errors.grades.onlyManualDeleted')] });
    await ctx.perm.require('grade:manage', item.courseId);
  },
  async handler(ctx, { id }) {
    const current = await ctx.tx.gradeItem.findUniqueOrThrow({ where: { id } });
    const usedBy = await formulasUsing(ctx.tx, current.courseId, { itemId: id });
    if (usedBy.length)
      throw new ValidationError({
        id: [msg('errors.grades.itemUsedBy', { usedBy: usedBy.join(', ') })],
      });
    const item = await ctx.tx.gradeItem.delete({ where: { id } });
    const users = await ctx.tx.enrolment.findMany({
      where: { courseId: item.courseId },
      select: { userId: true },
    });
    await recomputeTotalsOf(ctx.tx, item.courseId, [...new Set(users.map((u) => u.userId))]);
    return { id };
  },
});

/** The calculated items can be put in order: no formula uses itself, however indirectly. */
function requireOrder(
  items: {
    id: string;
    idNumber: string | null;
    categoryId: string | null;
    calculation: string | null;
  }[],
  categories: { id: string; idNumber: string | null; parentId: string | null }[],
) {
  try {
    calculationOrder(items, categories);
  } catch (e) {
    if (e instanceof CalculationError)
      throw new ValidationError({
        calculation: [msg('errors.grades.circularFormula')],
      });
    throw e;
  }
}

/**
 * A manual item's formula, written with [[idnumber]] references (null removes it). The
 * grades are computed at once for everyone.
 */
export const setGradeCalculation = defineOperation({
  name: 'grade.item.calculation',
  input: z.object({
    id: z.string().uuid(),
    calculation: z.string().trim().max(2000).nullable(),
  }),
  async authorize(ctx, i) {
    const item = await ctx.db.gradeItem.findUnique({ where: { id: i.id } });
    if (!item) throw new NotFoundError('Grade item');
    await ctx.perm.require('grade:manage', item.courseId);
  },
  async handler(ctx, { id, calculation }) {
    const item = await ctx.tx.gradeItem.findUniqueOrThrow({ where: { id } });
    if (item.kind !== 'MANUAL' || item.gradeType !== 'VALUE')
      throw new ValidationError({ calculation: [msg('errors.grades.onlyPointsCalculate')] });
    let stored: string | null = null;
    if (calculation) {
      const [categories, items] = await Promise.all([
        ctx.tx.gradeCategory.findMany({ where: { courseId: item.courseId } }),
        ctx.tx.gradeItem.findMany({ where: { courseId: item.courseId } }),
      ]);
      try {
        stored = storeCalculation(calculation, items, categories);
      } catch (e) {
        if (e instanceof CalculationError) throw new ValidationError({ calculation: [e.msg] });
        throw e;
      }
      requireOrder(
        items.map((i) => (i.id === id ? { ...i, calculation: stored } : i)),
        categories,
      );
    }
    await ctx.tx.gradeItem.update({
      where: { id },
      data: { calculation: stored, needsUpdate: false },
    });
    await recomputeEveryone(ctx.tx, item.courseId);
    await logEvent(ctx.tx, {
      name: 'grade.calculation.updated',
      actorId: ctx.perm.userId,
      courseId: item.courseId,
      objectId: id,
      origin: ctx.origin,
    });
    return { id, calculation: stored };
  },
});

/** The formulas of a course's items as teachers read them, by item id. */
export function displayCalculations(
  items: {
    id: string;
    idNumber: string | null;
    categoryId: string | null;
    calculation: string | null;
  }[],
  categories: { id: string; idNumber: string | null; parentId: string | null }[],
): Map<string, string> {
  return new Map(
    items
      .filter((i) => i.calculation)
      .map((i) => [i.id, displayCalculation(i.calculation!, items, categories)]),
  );
}

const AGGREGATIONS = ['NATURAL', 'MEAN', 'WEIGHTED_MEAN', 'HIGHEST', 'LOWEST', 'MEDIAN'] as const;

async function recomputeEveryone(tx: Tx, courseId: string) {
  const users = await tx.enrolment.findMany({ where: { courseId }, select: { userId: true } });
  await recomputeTotalsOf(tx, courseId, [...new Set(users.map((u) => u.userId))]);
}

/** Ids of a category and everything below it. */
async function subtreeIds(tx: Tx, courseId: string, rootId: string): Promise<Set<string>> {
  const all = await tx.gradeCategory.findMany({
    where: { courseId },
    select: { id: true, parentId: true },
  });
  const out = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of all)
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
  }
  return out;
}

export const saveGradeCategory = defineOperation({
  name: 'grade.category.save',
  input: z.object({
    courseId: z.string().uuid(),
    id: z.string().uuid().optional(),
    /** Parent category; new categories go under the root by default. */
    parentId: z.string().uuid().optional(),
    name: z.string().trim().max(255).default(''),
    aggregation: z.enum(AGGREGATIONS),
    dropLowest: z.coerce.number().int().min(0).max(100).default(0),
    keepHighest: z.coerce.number().int().min(0).max(100).default(0),
    aggregateOnlyGraded: z.boolean().default(true),
    weight: z.coerce.number().min(0).max(1000).default(1),
    /** The category in formulas. */
    idNumber: optionalText(100),
  }),
  authorize: (ctx, i) => ctx.perm.require('grade:manage', i.courseId),
  async handler(ctx, input) {
    const { root } = await ensureCourseGradebook(ctx.tx, input.courseId);
    const current = input.id ? await requireGradeCategory(ctx.tx, input.courseId, input.id) : null;
    const idNumber = input.idNumber ?? null;
    if (idNumber !== (current?.idNumber ?? null)) {
      if (
        !idNumber &&
        current &&
        (await formulasUsing(ctx.tx, input.courseId, { categoryId: current.id })).length
      )
        throw new ValidationError({
          idNumber: [msg('errors.grades.categoryNeedsIdNumber')],
        });
      await requireFreeIdNumber(ctx.tx, input.courseId, idNumber, { categoryId: current?.id });
    }
    const isRoot = current?.id === root.id;
    if (!isRoot && !input.id && !input.name)
      throw new ValidationError({ name: [msg('errors.grades.nameCategory')] });
    let parentId = isRoot ? null : (input.parentId ?? current?.parentId ?? root.id);
    if (parentId) {
      await requireGradeCategory(ctx.tx, input.courseId, parentId);
      if (current && (await subtreeIds(ctx.tx, input.courseId, current.id)).has(parentId))
        throw new ValidationError({ parentId: [msg('errors.grades.categoryInItself')] });
    } else parentId = null;
    const data = {
      name: input.name,
      idNumber,
      aggregation: input.aggregation,
      dropLowest: input.dropLowest,
      keepHighest: input.keepHighest,
      aggregateOnlyGraded: input.aggregateOnlyGraded,
      weight: input.weight,
      parentId,
    };
    // moving a category may put a formula's item inside a category its formula uses
    if (current && parentId !== current.parentId) {
      const [categories, items] = await Promise.all([
        ctx.tx.gradeCategory.findMany({ where: { courseId: input.courseId } }),
        ctx.tx.gradeItem.findMany({ where: { courseId: input.courseId } }),
      ]);
      requireOrder(
        items,
        categories.map((c) => (c.id === current.id ? { ...c, parentId } : c)),
      );
    }
    let cat: GradeCategory;
    if (current) cat = await ctx.tx.gradeCategory.update({ where: { id: current.id }, data });
    else {
      const last = await ctx.tx.gradeCategory.aggregate({
        where: { courseId: input.courseId, parentId },
        _max: { sortOrder: true },
      });
      cat = await ctx.tx.gradeCategory.create({
        data: { ...data, courseId: input.courseId, sortOrder: (last._max.sortOrder ?? 0) + 1 },
      });
    }
    await recomputeEveryone(ctx.tx, input.courseId);
    return { id: cat.id };
  },
});

/** Deletes a category; its items and subcategories move up to its parent. */
export const deleteGradeCategory = defineOperation({
  name: 'grade.category.delete',
  input: z.object({ courseId: z.string().uuid(), id: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('grade:manage', i.courseId),
  async handler(ctx, { courseId, id }) {
    const cat = await requireGradeCategory(ctx.tx, courseId, id);
    if (!cat.parentId)
      throw new ValidationError({ id: [msg('errors.grades.courseCategoryFixed')] });
    const usedBy = await formulasUsing(ctx.tx, courseId, { categoryId: id });
    if (usedBy.length)
      throw new ValidationError({
        id: [msg('errors.grades.categoryUsedBy', { usedBy: usedBy.join(', ') })],
      });
    // its items move up: none may land in a category its own formula uses
    const [categories, items] = await Promise.all([
      ctx.tx.gradeCategory.findMany({ where: { courseId } }),
      ctx.tx.gradeItem.findMany({ where: { courseId } }),
    ]);
    requireOrder(
      items.map((i) => (i.categoryId === id ? { ...i, categoryId: cat.parentId } : i)),
      categories
        .filter((c) => c.id !== id)
        .map((c) => (c.parentId === id ? { ...c, parentId: cat.parentId } : c)),
    );
    await ctx.tx.gradeItem.updateMany({
      where: { categoryId: id },
      data: { categoryId: cat.parentId },
    });
    await ctx.tx.gradeCategory.updateMany({
      where: { parentId: id },
      data: { parentId: cat.parentId },
    });
    await ctx.tx.gradeCategory.delete({ where: { id } });
    await recomputeEveryone(ctx.tx, courseId);
    return { id };
  },
});

/** Moves a category or an item one place up or down among its siblings. */
export const moveGradebookEntry = defineOperation({
  name: 'grade.move',
  input: z.object({
    courseId: z.string().uuid(),
    kind: z.enum(['category', 'item']),
    id: z.string().uuid(),
    direction: z.enum(['up', 'down']),
  }),
  authorize: (ctx, i) => ctx.perm.require('grade:manage', i.courseId),
  async handler(ctx, { courseId, kind, id, direction }) {
    const { root } = await ensureCourseGradebook(ctx.tx, courseId);
    const order = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];
    let siblings: { id: string }[];
    if (kind === 'category') {
      const cat = await requireGradeCategory(ctx.tx, courseId, id);
      if (!cat.parentId) return { ok: true };
      siblings = await ctx.tx.gradeCategory.findMany({
        where: { courseId, parentId: cat.parentId },
        orderBy: order,
        select: { id: true },
      });
    } else {
      const item = await ctx.tx.gradeItem.findFirst({ where: { id, courseId } });
      if (!item || item.kind === 'COURSE') throw new NotFoundError('Grade item');
      const categoryId = item.categoryId ?? root.id;
      siblings = await ctx.tx.gradeItem.findMany({
        where: {
          courseId,
          kind: { not: 'COURSE' },
          OR: [{ categoryId }, ...(categoryId === root.id ? [{ categoryId: null }] : [])],
        },
        orderBy: order,
        select: { id: true },
      });
    }
    const i = siblings.findIndex((x) => x.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= siblings.length) return { ok: true };
    [siblings[i], siblings[j]] = [siblings[j]!, siblings[i]!];
    for (const [n, x] of siblings.entries()) {
      if (kind === 'category')
        await ctx.tx.gradeCategory.update({ where: { id: x.id }, data: { sortOrder: n + 1 } });
      else await ctx.tx.gradeItem.update({ where: { id: x.id }, data: { sortOrder: n + 1 } });
    }
    return { ok: true };
  },
});

// ── reports ───────────────────────────────────────────────────────────────────

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
/**
 * The learners a course report shows the viewer: those graded in the course (grade:view),
 * whatever their role is called, with an active enrolment; in separate groups, the
 * viewer's groups' members only, unless they see all groups. With `groupId`, that group's.
 */
export async function reportLearners(
  ctx: RequestContext,
  courseId: string,
  opts: { groupId?: string } = {},
): Promise<string[]> {
  const learners = await usersWithCap(ctx.db, 'grade:view', courseId);
  const own = await separateGroupsOf(ctx, courseId);
  const groups = opts.groupId ? (own ?? [opts.groupId]).filter((g) => g === opts.groupId) : own;
  if (!groups) return learners;
  const members = await ctx.db.groupMember.findMany({
    where: { groupId: { in: groups }, userId: { in: learners } },
    select: { userId: true },
  });
  return [...new Set(members.map((m) => m.userId))];
}

export async function graderReport(
  ctx: RequestContext,
  courseId: string,
  opts: { groupId?: string; page?: number; pageSize?: number } = {},
) {
  await ctx.perm.require('grade:viewall', courseId);
  const { categories, items } = await gradebookStructure(ctx.db, courseId);
  const where = {
    id: { in: await reportLearners(ctx, courseId, opts) },
    deletedAt: null,
  };
  // with a page, that page of learners (exports leave it out and get everyone)
  const pageSize = opts.page ? Math.min(500, Math.max(1, Math.floor(opts.pageSize ?? 50))) : null;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const [users, counted] = await Promise.all([
    ctx.db.user.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, email: true, username: true, emailPlaceholder: true },
      ...(pageSize ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
    }),
    pageSize ? ctx.db.user.count({ where }) : null,
  ]);
  const grades = await ctx.db.grade.findMany({
    where: { item: { courseId }, userId: { in: users.map((u) => u.id) } },
  });
  const cell = new Map(grades.map((g) => [`${g.userId}:${g.gradeItemId}`, g]));
  return {
    categories,
    items,
    users,
    cell,
    total: counted ?? users.length,
    page,
    pageSize: pageSize ?? Math.max(1, users.length),
  };
}

/** The learners of the grader report by name, without their grades (for filters). */
export async function reportLearnerNames(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('grade:viewall', courseId);
  return ctx.db.user.findMany({
    where: { id: { in: await reportLearners(ctx, courseId) }, deletedAt: null },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });
}

/**
 * A learner's grades: for the learner, for those with `grade:viewall` in the course, and for
 * the learner's mentors (see users/mentors.ts) when the learner may see their grades. The
 * learner and mentors don't get hidden items.
 */
export async function userReport(ctx: RequestContext, courseId: string, userId: string) {
  const self = ctx.perm.userId === userId;
  const viewAll = await ctx.perm.can('grade:viewall', courseId);
  if (!self && !viewAll) {
    const mentor = !!ctx.perm.userId && (await isMentorOf(ctx.db, ctx.perm.userId, userId));
    if (!mentor || !(await (await learnerPermissions(ctx.db, userId)).can('grade:view', courseId)))
      throw new ForbiddenError();
  } else if (self && !viewAll && !(await ctx.perm.can('grade:view', courseId))) {
    throw new ForbiddenError();
  }
  const { categories, items } = await gradebookStructure(ctx.db, courseId);
  const now = new Date();
  const visible = !viewAll ? items.filter((i) => !hiddenFromLearner(i, now)) : items;
  const grades = await ctx.db.grade.findMany({
    where: { userId, gradeItemId: { in: visible.map((i) => i.id) } },
  });
  const byItem = new Map(grades.map((g) => [g.gradeItemId, g]));
  if (!viewAll) totalWithoutHidden(categories, items, visible, byItem, now);
  return { categories, items: visible, grades: byItem };
}

type LearnerItem = Pick<GradeItem, 'hidden' | 'hiddenUntil'> & {
  activity?: { visibility: string } | null;
};

/** Hidden from learners (and their mentors): by the teacher, until a date, or with its activity. */
export function hiddenFromLearner(i: LearnerItem, now = new Date()): boolean {
  return (
    i.hidden || (!!i.hiddenUntil && i.hiddenUntil > now) || i.activity?.visibility === 'HIDDEN'
  );
}

/**
 * With items hidden from the learner, the course total they see is worked out again over the
 * items they do see, as Moodle shows totals by default, so it does not give the hidden grades
 * away. Replaces the total in `grades`; does nothing when nothing is hidden.
 */
function totalWithoutHidden(
  categories: TreeCategory[],
  items: (TreeItem & LearnerItem & Pick<GradeItem, 'kind' | 'gradeType'>)[],
  visible: typeof items,
  grades: Map<string, Prisma.GradeGetPayload<object>>,
  now: Date,
) {
  const scored = (i: (typeof items)[number]) =>
    (i.kind === 'MODULE' || i.kind === 'MANUAL') &&
    (i.gradeType === 'VALUE' || i.gradeType === 'SCALE');
  if (!items.some((i) => scored(i) && hiddenFromLearner(i, now))) return;
  const total = visible.find((i) => i.kind === 'COURSE');
  const stored = total && grades.get(total.id);
  if (!total || !stored) return;
  const rows = [...grades.values()].map((g) => ({
    gradeItemId: g.gradeItemId,
    finalGrade: g.finalGrade,
    excluded: g.excluded,
  }));
  const fraction = categoryFraction(null, categories, visible.filter(scored), rows);
  grades.set(total.id, {
    ...stored,
    finalGrade: fraction === null ? null : new Prisma.Decimal(fraction * num(total.gradeMax)!),
  });
}

/** The course total a learner sees (see totalWithoutHidden); null when none. */
export async function learnerCourseTotal(db: Tx, courseId: string, userId: string) {
  const { categories, items } = await gradebookStructure(db, courseId);
  const now = new Date();
  const visible = items.filter((i) => !hiddenFromLearner(i, now));
  const grades = await db.grade.findMany({
    where: { userId, gradeItemId: { in: visible.map((i) => i.id) } },
  });
  const byItem = new Map(grades.map((g) => [g.gradeItemId, g]));
  totalWithoutHidden(categories, items, visible, byItem, now);
  const total = visible.find((i) => i.kind === 'COURSE');
  return total ? (byItem.get(total.id)?.finalGrade ?? null) : null;
}

/** Rows of the grade export (header first): points as numbers, scale grades by name. */
export async function gradeExportRows(
  ctx: RequestContext,
  courseId: string,
): Promise<(string | number | null)[][]> {
  await ctx.perm.require('grade:export', courseId);
  const r = await graderReport(ctx, courseId);
  const items = [
    ...r.items.filter((i) => i.kind !== 'CATEGORY' && i.kind !== 'COURSE'),
    ...r.items.filter((i) => i.kind === 'COURSE'),
  ];
  const header = [
    'firstname lastname',
    'email',
    'username',
    ...items.map((i) =>
      i.kind === 'COURSE' ? createTranslator(ctx.locale)('grades.total') : i.name,
    ),
  ];
  return [
    header,
    ...r.users.map((u) => [
      u.name,
      u.emailPlaceholder ? '' : u.email,
      u.username ?? '',
      ...items.map((i) => {
        const v = num(r.cell.get(`${u.id}:${i.id}`)?.finalGrade);
        if (v === null) return null;
        if (i.scale) return i.scale.items[Math.round(v) - 1] ?? null;
        return Math.round(v * 100) / 100;
      }),
    ]),
  ];
}

export async function exportGradesCsv(ctx: RequestContext, courseId: string): Promise<string> {
  return csvFile(await gradeExportRows(ctx, courseId));
}

export async function exportGradesXlsx(ctx: RequestContext, courseId: string): Promise<Uint8Array> {
  return writeXlsx(
    await gradeExportRows(ctx, courseId),
    createTranslator(ctx.locale)('grades.title'),
  );
}

/** The grades as an OpenDocument spreadsheet (LibreOffice, and Excel opens it too). */
export async function exportGradesOds(ctx: RequestContext, courseId: string): Promise<Uint8Array> {
  return writeOds(
    await gradeExportRows(ctx, courseId),
    createTranslator(ctx.locale)('grades.title'),
  );
}

// ── history ───────────────────────────────────────────────────────────────────

export const GradeHistoryQuery = z.object({
  userId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Changes of grades in a course, newest first (course totals only when asked for). */
export async function gradeHistory(
  ctx: RequestContext,
  courseId: string,
  raw: z.input<typeof GradeHistoryQuery>,
) {
  await ctx.perm.require('grade:viewall', courseId);
  const q = GradeHistoryQuery.parse(raw);
  const where: Prisma.GradeHistoryWhereInput = {
    grade: {
      item: { courseId, ...(q.itemId ? { id: q.itemId } : { kind: { not: 'COURSE' } }) },
      ...(q.userId ? { userId: q.userId } : {}),
    },
    ...(q.from || q.to
      ? { changedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } }
      : {}),
  };
  const [total, rows] = await Promise.all([
    ctx.db.gradeHistory.count({ where }),
    ctx.db.gradeHistory.findMany({
      where,
      orderBy: { changedAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        grade: {
          select: {
            user: { select: { id: true, name: true } },
            item: {
              select: {
                id: true,
                name: true,
                kind: true,
                gradeMin: true,
                gradeMax: true,
                decimals: true,
                display: true,
                scale: { select: { items: true } },
              },
            },
          },
        },
      },
    }),
  ]);
  const changers = await ctx.db.user.findMany({
    where: {
      id: { in: [...new Set(rows.flatMap((r) => (r.changedById ? [r.changedById] : [])))] },
    },
    select: { id: true, name: true },
  });
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    rows: rows.map((r) => ({
      id: r.id,
      changedAt: r.changedAt,
      source: r.source,
      overridden: r.overridden,
      previousGrade: num(r.previousGrade),
      finalGrade: num(r.finalGrade),
      feedback: r.feedback,
      user: r.grade.user,
      item: r.grade.item,
      changedBy: changers.find((c) => c.id === r.changedById) ?? null,
    })),
  };
}

/** Imports grades for MANUAL items by column name; users matched by email or username. */
export { num as decimalToNumber };
