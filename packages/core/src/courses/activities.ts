import { type Activity, type CompletionState, Prisma, uuidv7 } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { parseSettings } from '@hubium/module-sdk';
import { z } from 'zod';
import { createContext } from '../access/contexts.ts';
import type { MutationContext, RequestContext } from '../context.ts';
import { NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { recomputeAllTotals, requireActivityIdNumber } from '../grades/gradebook.ts';
import { enqueue } from '../jobs/jobs.ts';
import { rankBetween } from '../lib/rank.ts';
import { optionalText } from '../lib/zod.ts';
import { buildModuleCtx, toActivityRef } from '../modules/module-ctx.ts';
import { requireModule } from '../modules/registry.ts';
import { defineOperation } from '../operation.ts';
import { assertModuleEnabled, isModuleEnabled } from '../settings/modules.ts';
import { getAllSettings, getSetting } from '../settings/settings.ts';
import { profileValueText } from '../users/profile-fields.ts';
import {
  type AvailabilityFacts,
  AvailabilityTreeSchema,
  type CompletionFact,
  evaluateAvailability,
  parseAvailability,
} from './availability.ts';
import { getCourseAccess } from './courses.ts';
import { rankAtEnd, rankForStep, sectionItems } from './section-items.ts';

const CompletionRules = z
  .object({
    /** Viewing the activity is required. */
    view: z.boolean().optional(),
    /** Module-specific rules (validated by the module's completion schema). */
    module: z.record(z.string(), z.unknown()).optional(),
  })
  .default({});

const dateOrNull = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v ? new Date(v) : null))
  .refine((d) => d === null || !Number.isNaN(d.getTime()), 'Invalid date');

export const ActivityInput = z.object({
  courseId: z.string().uuid(),
  sectionId: z.string().uuid(),
  moduleKey: z.string().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  intro: z.string().max(200_000).default(''),
  showIntro: z.boolean().default(false),
  visibility: z.enum(['SHOWN', 'HIDDEN', 'STEALTH']).default('SHOWN'),
  completionMode: z.enum(['NONE', 'MANUAL', 'AUTO']).default('NONE'),
  completionRules: CompletionRules,
  completionExpectedAt: dateOrNull,
  groupMode: z.enum(['NONE', 'SEPARATE', 'VISIBLE']).default('NONE'),
  /** Limits group mode to the groups of one grouping of the course. */
  groupingId: z.string().uuid().nullable().optional(),
  availability: z.unknown().optional(),
  idNumber: optionalText(100),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type ActivityInputType = z.input<typeof ActivityInput>;

/**
 * Group mode and grouping to store: a course with a forced group mode imposes its own, and
 * the grouping must belong to the course.
 */
async function groupSetup(
  tx: Prisma.TransactionClient,
  courseId: string,
  input: { groupMode: 'NONE' | 'SEPARATE' | 'VISIBLE'; groupingId?: string | null },
) {
  const course = await tx.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { groupMode: true, groupModeForced: true },
  });
  const groupingId = input.groupingId ?? null;
  if (groupingId && !(await tx.grouping.findFirst({ where: { id: groupingId, courseId } })))
    throw new ValidationError({ groupingId: ['Unknown grouping'] });
  return {
    groupMode: course.groupModeForced ? course.groupMode : input.groupMode,
    groupingId,
  };
}

/** `stored`: the activity's current settings, when updating it. */
function validateSettings(moduleKey: string, raw: Record<string, unknown>, stored?: unknown) {
  const m = requireModule(moduleKey);
  const defaults = m.settings.defaults() as Record<string, unknown>;
  const input = { ...defaults, ...raw };
  // fields the module keeps up itself are not the form's to set
  const old = (stored ?? {}) as Record<string, unknown>;
  for (const key of m.settings.managed ?? [])
    input[key] = stored !== undefined && key in old ? old[key] : defaults[key];
  const r = m.settings.schema.safeParse(input);
  if (!r.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const i of r.error.issues)
      (fieldErrors[`settings.${i.path.join('.')}`] ??= []).push(i.message);
    throw new ValidationError(fieldErrors);
  }
  return r.data as Prisma.InputJsonValue;
}

function validateCompletion(
  moduleKey: string,
  mode: string,
  rules: z.output<typeof CompletionRules>,
) {
  if (mode !== 'AUTO') return {};
  const m = requireModule(moduleKey);
  const out: Record<string, unknown> = {};
  if (rules.view) out.view = true;
  if (m.completion && rules.module && Object.keys(rules.module).length) {
    const r = m.completion.schema.safeParse(rules.module);
    if (!r.success) {
      throw new ValidationError({
        completionRules: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    out.module = r.data;
  }
  if (!Object.keys(out).length) {
    throw new ValidationError({
      completionRules: ['Choose at least one automatic completion condition'],
    });
  }
  return out;
}

/** Returns the tree to store, or DbNull for "no restrictions". */
function validateAvailability(raw: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (raw === undefined || raw === null || raw === '') return Prisma.DbNull;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ValidationError({ availability: ['Invalid access restrictions'] });
    }
  }
  const r = AvailabilityTreeSchema.safeParse(value);
  if (!r.success) throw new ValidationError({ availability: ['Invalid access restrictions'] });
  return r.data.c.length ? (r.data as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
}

/** The calendar events an activity's module declares, kept in step with its settings. */
export async function syncCalendar(tx: Prisma.TransactionClient, a: Activity): Promise<void> {
  const m = requireModule(a.moduleKey);
  const specs = m.calendar?.events(toActivityRef(a)) ?? [];
  const kinds = specs.map((s) => s.kind);
  await tx.calendarEvent.deleteMany({ where: { activityId: a.id, kind: { notIn: kinds } } });
  for (const s of specs) {
    await tx.calendarEvent.upsert({
      where: { activityId_kind: { activityId: a.id, kind: s.kind } },
      create: {
        scope: 'COURSE',
        courseId: a.courseId,
        activityId: a.id,
        moduleKey: a.moduleKey,
        kind: s.kind,
        title: s.title,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        visible: a.visibility === 'SHOWN' && !a.deletedAt,
      },
      update: {
        title: s.title,
        startsAt: s.startsAt,
        endsAt: s.endsAt ?? null,
        visible: a.visibility === 'SHOWN' && !a.deletedAt,
      },
    });
  }
}

/** Re-index the activity for AI retrieval (debounced; no-op while AI is off). */
async function scheduleAiIndex(ctx: RequestContext, activityId: string) {
  if (!(await getSetting(ctx.db, 'ai.enabled'))) return;
  await enqueue(
    'ai.index.activity',
    { activityId },
    // An edit inside the 30 s window is queued for the next slot instead of being dropped.
    { singletonKey: activityId, singletonSeconds: 30, singletonNextSlot: true, startAfter: 5 },
  );
}

/**
 * Activities are created from the types that are turned on; restored backups and imports
 * bring theirs back whatever the state, so turning a type on again shows them.
 */
const activityCreate = (name: string, restoring: boolean) =>
  defineOperation({
    name,
    input: ActivityInput,
    async authorize(ctx, i) {
      await ctx.perm.require('course:manageactivities', i.courseId);
      if (!restoring) await assertModuleEnabled(ctx.db, i.moduleKey);
    },
    handler: (ctx, input) => insertActivity(ctx, input),
  });

async function insertActivity(ctx: MutationContext, input: z.output<typeof ActivityInput>) {
  const section = await ctx.tx.courseSection.findUnique({ where: { id: input.sectionId } });
  if (!section || section.courseId !== input.courseId)
    throw new ValidationError({ sectionId: ['Unknown section'] });
  const settings = validateSettings(input.moduleKey, input.settings);
  const completionRules = validateCompletion(
    input.moduleKey,
    input.completionMode,
    input.completionRules,
  );
  const availability = validateAvailability(input.availability);
  const groups = await groupSetup(ctx.tx, input.courseId, input);
  const id = uuidv7();
  await createContext(ctx.tx, id, 'ACTIVITY', input.courseId);
  await requireActivityIdNumber(ctx.tx, input.courseId, input.idNumber);
  const a = await ctx.tx.activity.create({
    data: {
      id,
      courseId: input.courseId,
      sectionId: input.sectionId,
      moduleKey: input.moduleKey,
      rank: await rankAtEnd(ctx.tx, input.sectionId),
      name: input.name,
      intro: sanitizeRichText(input.intro),
      showIntro: input.showIntro,
      visibility: input.visibility,
      completionMode: input.completionMode,
      completionRules: completionRules as Prisma.InputJsonValue,
      completionExpectedAt: input.completionExpectedAt,
      ...groups,
      availability,
      idNumber: input.idNumber,
      settings,
      createdById: ctx.perm.userId,
    },
  });
  const m = requireModule(a.moduleKey);
  const mctx = buildModuleCtx(ctx, ctx.tx);
  await m.lifecycle?.onCreate?.(mctx, toActivityRef(a));
  if (m.grading) await mctx.grades.syncItems(a.id).catch(() => {});
  await syncCalendar(ctx.tx, a);
  await logEvent(ctx.tx, {
    name: 'activity.created',
    actorId: ctx.perm.userId,
    courseId: a.courseId,
    contextId: a.id,
    objectType: a.moduleKey,
    objectId: a.id,
    origin: ctx.origin,
  });
  await scheduleAiIndex(ctx, id);
  return { id };
}

export const createActivity = activityCreate('activity.create', false);
/** createActivity for course restore and import: also types that are turned off. */
export const importActivity = activityCreate('activity.import', true);

export const updateActivity = defineOperation({
  name: 'activity.update',
  input: ActivityInput.omit({ courseId: true, sectionId: true, moduleKey: true }).extend({
    id: z.string().uuid(),
  }),
  authorize: (ctx, i) => authorizeActivity(ctx, i.id, { enabledType: true }),
  async handler(ctx, input) {
    const prev = await ctx.tx.activity.findUniqueOrThrow({ where: { id: input.id } });
    if ((input.idNumber ?? null) !== prev.idNumber)
      await requireActivityIdNumber(ctx.tx, prev.courseId, input.idNumber, prev.id);
    const settings = validateSettings(prev.moduleKey, input.settings, prev.settings ?? {});
    const completionRules = validateCompletion(
      prev.moduleKey,
      input.completionMode,
      input.completionRules,
    );
    const availability = validateAvailability(input.availability);
    const groups = await groupSetup(ctx.tx, prev.courseId, input);
    const a = await ctx.tx.activity.update({
      where: { id: prev.id },
      data: {
        name: input.name,
        intro: sanitizeRichText(input.intro),
        showIntro: input.showIntro,
        visibility: input.visibility,
        completionMode: input.completionMode,
        completionRules: completionRules as Prisma.InputJsonValue,
        completionExpectedAt: input.completionExpectedAt,
        ...groups,
        availability,
        idNumber: input.idNumber ?? null,
        settings,
        version: { increment: 1 },
      },
    });
    const m = requireModule(a.moduleKey);
    const mctx = buildModuleCtx(ctx, ctx.tx);
    await m.lifecycle?.onUpdate?.(mctx, toActivityRef(a), parseSettings(m, prev.settings));
    if (m.grading) await mctx.grades.syncItems(a.id).catch(() => {});
    await syncCalendar(ctx.tx, a);
    // New completion rules apply to everyone, not just to the next person who acts.
    if (
      a.completionMode === 'AUTO' &&
      (prev.completionMode !== 'AUTO' ||
        JSON.stringify(prev.completionRules ?? {}) !== JSON.stringify(completionRules))
    )
      await enqueue(
        'completion.recompute',
        { activityId: a.id },
        { tx: ctx.tx, singletonKey: a.id, singletonSeconds: 60, singletonNextSlot: true },
      );
    await logEvent(ctx.tx, {
      name: 'activity.updated',
      actorId: ctx.perm.userId,
      courseId: a.courseId,
      contextId: a.id,
      origin: ctx.origin,
    });
    await scheduleAiIndex(ctx, a.id);
    return { id: a.id };
  },
});

/** Editing and copying also need the activity's type to be turned on. */
async function authorizeActivity(
  ctx: RequestContext,
  id: string,
  opts: { enabledType?: boolean } = {},
) {
  const a = await ctx.db.activity.findUnique({
    where: { id },
    select: { courseId: true, moduleKey: true },
  });
  if (!a) throw new NotFoundError('Activity');
  await ctx.perm.require('course:manageactivities', a.courseId);
  if (opts.enabledType) await assertModuleEnabled(ctx.db, a.moduleKey);
}

export const setActivityVisibility = defineOperation({
  name: 'activity.visibility',
  input: z.object({ id: z.string().uuid(), visibility: z.enum(['SHOWN', 'HIDDEN', 'STEALTH']) }),
  authorize: (ctx, i) => authorizeActivity(ctx, i.id),
  async handler(ctx, { id, visibility }) {
    const a = await ctx.tx.activity.update({ where: { id }, data: { visibility } });
    await syncCalendar(ctx.tx, a);
    return { id };
  },
});

/** Moves an activity to a section, before another activity or subsection (or to the end). */
export const moveActivity = defineOperation({
  name: 'activity.move',
  input: z.object({
    id: z.string().uuid(),
    sectionId: z.string().uuid(),
    beforeId: z.string().uuid().nullable().optional(),
  }),
  authorize: (ctx, i) => authorizeActivity(ctx, i.id),
  async handler(ctx, { id, sectionId, beforeId }) {
    const a = await ctx.tx.activity.findUniqueOrThrow({ where: { id } });
    const section = await ctx.tx.courseSection.findUnique({ where: { id: sectionId } });
    if (!section || section.courseId !== a.courseId)
      throw new ValidationError({ sectionId: ['Unknown section'] });
    const siblings = (await sectionItems(ctx.tx, sectionId, { withDeleted: true })).filter(
      (x) => x.id !== id,
    );
    let rank: string;
    if (beforeId) {
      const i = siblings.findIndex((s) => s.id === beforeId);
      if (i < 0) throw new ValidationError({ beforeId: ['Unknown activity'] });
      rank = rankBetween(siblings[i - 1]?.rank ?? null, siblings[i]!.rank);
    } else {
      rank = rankBetween(siblings.at(-1)?.rank ?? null, null);
    }
    await ctx.tx.activity.update({ where: { id }, data: { sectionId, rank } });
    return { id };
  },
});

export const moveActivityStep = defineOperation({
  name: 'activity.moveStep',
  input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
  authorize: (ctx, i) => authorizeActivity(ctx, i.id),
  async handler(ctx, { id, direction }) {
    const a = await ctx.tx.activity.findUniqueOrThrow({ where: { id } });
    // past the neighbouring activity or subsection
    const rank = rankForStep(await sectionItems(ctx.tx, a.sectionId), id, direction);
    if (rank) await ctx.tx.activity.update({ where: { id }, data: { rank } });
    return { id };
  },
});

/** Grade items follow the activity into and out of the recycle bin (and the totals with them). */
async function syncGrades(ctx: RequestContext & { tx: Prisma.TransactionClient }, a: Activity) {
  if (!requireModule(a.moduleKey).grading) return;
  await buildModuleCtx(ctx, ctx.tx).grades.syncItems(a.id);
  // items in the recycle bin do not count towards the totals
  if (await ctx.tx.gradeItem.count({ where: { activityId: a.id } }))
    await recomputeAllTotals(ctx.tx, a.courseId);
}

export const deleteActivity = defineOperation({
  name: 'activity.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => authorizeActivity(ctx, i.id),
  async handler(ctx, { id }) {
    const a = await ctx.tx.activity.update({ where: { id }, data: { deletedAt: ctx.now } });
    await syncCalendar(ctx.tx, a);
    await syncGrades(ctx, a);
    await logEvent(ctx.tx, {
      name: 'activity.deleted',
      actorId: ctx.perm.userId,
      courseId: a.courseId,
      objectId: id,
      origin: ctx.origin,
    });
    await scheduleAiIndex(ctx, id);
    return { id };
  },
});

export const restoreActivity = defineOperation({
  name: 'activity.restore',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => authorizeActivity(ctx, i.id),
  async handler(ctx, { id }) {
    const a = await ctx.tx.activity.update({ where: { id }, data: { deletedAt: null } });
    await syncCalendar(ctx.tx, a);
    await syncGrades(ctx, a);
    await scheduleAiIndex(ctx, id);
    return { id };
  },
});

/** Permanently removes an activity from the recycle bin. */
export const purgeActivity = defineOperation({
  name: 'activity.purge',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => authorizeActivity(ctx, i.id),
  async handler(ctx, { id }) {
    const a = await ctx.tx.activity.findUniqueOrThrow({ where: { id } });
    const m = requireModule(a.moduleKey);
    await m.lifecycle?.onDelete?.(buildModuleCtx(ctx, ctx.tx), toActivityRef(a));
    await ctx.tx.calendarEvent.deleteMany({ where: { activityId: id } });
    await ctx.tx.activity.delete({ where: { id } });
    await ctx.tx.context.delete({ where: { id } });
    return { id };
  },
});

export const duplicateActivity = defineOperation({
  name: 'activity.duplicate',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => authorizeActivity(ctx, i.id, { enabledType: true }),
  async handler(ctx, { id }) {
    const a = await ctx.tx.activity.findUniqueOrThrow({ where: { id } });
    const items = await sectionItems(ctx.tx, a.sectionId, { withDeleted: true });
    const next = items[items.findIndex((x) => x.id === id) + 1];
    const newId = uuidv7();
    await createContext(ctx.tx, newId, 'ACTIVITY', a.courseId);
    const copy = await ctx.tx.activity.create({
      data: {
        ...a,
        id: newId,
        name: `${a.name} (copy)`,
        rank: rankBetween(a.rank, next?.rank ?? null),
        visibility: 'HIDDEN',
        availability: a.availability ?? Prisma.DbNull,
        completionRules: a.completionRules ?? {},
        settings: a.settings ?? {},
        createdById: ctx.perm.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        version: 1,
      },
    });
    const files = await ctx.tx.file.findMany({ where: { contextId: a.id } });
    for (const f of files) {
      await ctx.tx.file.create({
        data: { ...f, id: uuidv7(), contextId: newId, createdAt: ctx.now, updatedAt: ctx.now },
      });
    }
    const m = requireModule(copy.moduleKey);
    await m.lifecycle?.onCreate?.(buildModuleCtx(ctx, ctx.tx), toActivityRef(copy));
    return { id: newId };
  },
});

// ── course outline for viewers ────────────────────────────────────────────────

export interface OutlineActivity {
  activity: Activity;
  /** Viewer can see the activity in the list. */
  listed: boolean;
  /** Viewer can open it (availability satisfied or can manage). */
  available: boolean;
  /** Its type is turned off (or missing from this build): listed to editors only, unopenable. */
  moduleDisabled: boolean;
  availabilityMissing: import('./availability.ts').Condition[];
  completion: CompletionState | null;
}

export interface OutlineSection {
  id: string;
  /** The section a subsection is in; null for a section of the course. */
  parentId: string | null;
  /** A subsection's rank is in its parent's order of activities and subsections. */
  rank: string;
  title: string;
  summary: string;
  visible: boolean;
  available: boolean;
  availabilityMissing: import('./availability.ts').Condition[];
  /** Number of the section in the course (0 is the general one); a subsection has its parent's. */
  index: number;
  activities: OutlineActivity[];
}

export async function loadAvailabilityFacts(
  ctx: RequestContext,
  courseId: string,
  userId: string | undefined,
): Promise<AvailabilityFacts> {
  if (!userId) {
    return {
      now: ctx.now,
      completion: new Map(),
      groupIds: new Set(),
      grades: new Map(),
      profile: {},
    };
  }
  const [completions, groups, groupings, user] = await Promise.all([
    ctx.db.activityCompletion.findMany({ where: { userId, activity: { courseId } } }),
    ctx.db.groupMember.findMany({
      where: { userId, group: { courseId } },
      select: { groupId: true },
    }),
    ctx.db.groupingGroup.findMany({
      where: { group: { courseId, members: { some: { userId } } } },
      select: { groupingId: true },
    }),
    ctx.db.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        firstName: true,
        lastName: true,
        username: true,
        customFields: true,
      },
    }),
  ]);
  const toFact = (s: CompletionState): CompletionFact =>
    s === 'COMPLETE_PASS'
      ? 'pass'
      : s === 'COMPLETE_FAIL'
        ? 'fail'
        : s === 'COMPLETE'
          ? 'complete'
          : 'incomplete';
  const grades = new Map<string, number>();
  const gradeRows = await ctx.db.$queryRaw<{ activityId: string; pct: number }[]>`
    SELECT gi."activityId" AS "activityId",
           (g."finalGrade" - gi."gradeMin") / NULLIF(gi."gradeMax" - gi."gradeMin", 0) * 100 AS pct
      FROM "Grade" g JOIN "GradeItem" gi ON gi.id = g."gradeItemId"
     WHERE g."userId" = ${userId}::uuid AND gi."courseId" = ${courseId}::uuid
       AND gi."activityId" IS NOT NULL AND gi."itemNumber" = 0 AND g."finalGrade" IS NOT NULL`.catch(
    () => [],
  );
  for (const r of gradeRows) grades.set(r.activityId, Number(r.pct));
  return {
    now: ctx.now,
    completion: new Map(completions.map((c) => [c.activityId, toFact(c.state)])),
    groupIds: new Set(groups.map((g) => g.groupId)),
    groupingIds: new Set(groupings.map((g) => g.groupingId)),
    grades,
    profile: {
      email: user?.email ?? '',
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
      username: user?.username ?? '',
      ...Object.fromEntries(
        Object.entries((user?.customFields ?? {}) as Record<string, string | boolean>).map(
          ([k, v]) => [`cf:${k}`, profileValueText(v)],
        ),
      ),
    },
  };
}

/**
 * Sections and activities as the viewer sees them (visibility, availability, completion).
 * Each section is followed by its subsections, which are hidden and restricted with it.
 */
export async function getCourseOutline(
  ctx: RequestContext,
  courseId: string,
  opts: { includeUnlisted?: boolean } = {},
): Promise<OutlineSection[]> {
  const access = await getCourseAccess(ctx, courseId);
  // Callers outside the course page (REST API, AI tutor) rely on this check.
  if (!access.canView || (access.course.deletedAt && !ctx.perm.isSiteAdmin))
    throw new NotFoundError('Course');
  const userId = ctx.perm.userId;
  const [sections, activities, facts, settings] = await Promise.all([
    ctx.db.courseSection.findMany({ where: { courseId }, orderBy: { rank: 'asc' } }),
    ctx.db.activity.findMany({ where: { courseId, deletedAt: null }, orderBy: { rank: 'asc' } }),
    loadAvailabilityFacts(ctx, courseId, userId),
    getAllSettings(ctx.db),
  ]);
  const manage = access.canManageActivities || access.canViewHidden;
  const completionMap = new Map<string, CompletionState>();
  if (userId) {
    const rows = await ctx.db.activityCompletion.findMany({
      where: { userId, activityId: { in: activities.map((a) => a.id) } },
    });
    for (const r of rows) completionMap.set(r.activityId, r.state);
  }
  const out: OutlineSection[] = [];
  const add = (
    s: (typeof sections)[number],
    index: number,
    parent?: { available: boolean; missing: OutlineSection['availabilityMissing'] },
  ) => {
    const own = evaluateAvailability(parseAvailability(s.availability), facts);
    if (!manage && (!s.visible || own.hidden)) return false;
    const sAvail = {
      available: own.available && (parent?.available ?? true),
      missing: [...(parent?.missing ?? []), ...own.missing],
    };
    const acts = activities
      .filter((a) => a.sectionId === s.id)
      .map((a): OutlineActivity => {
        const av = evaluateAvailability(parseAvailability(a.availability), facts);
        const moduleDisabled = !isModuleEnabled(settings, a.moduleKey);
        const listed = manage || (!moduleDisabled && a.visibility === 'SHOWN' && !av.hidden);
        const available =
          !moduleDisabled &&
          (manage || (a.visibility !== 'HIDDEN' && av.available && sAvail.available));
        return {
          activity: a,
          listed,
          available,
          moduleDisabled,
          availabilityMissing: [...sAvail.missing, ...av.missing],
          completion:
            a.completionMode === 'NONE' ? null : (completionMap.get(a.id) ?? 'INCOMPLETE'),
        };
      })
      .filter((x) => x.listed || opts.includeUnlisted);
    out.push({
      id: s.id,
      parentId: s.parentId,
      rank: s.rank,
      title: s.title,
      summary: s.summary,
      visible: s.visible,
      available: manage || sAvail.available,
      availabilityMissing: sAvail.missing,
      index,
      activities: acts,
    });
    return sAvail;
  };
  sections
    .filter((s) => !s.parentId)
    .forEach((s, index) => {
      const shown = add(s, index);
      if (!shown) return;
      for (const sub of sections.filter((x) => x.parentId === s.id)) add(sub, index, shown);
    });
  return out;
}

/**
 * Can the viewer open this activity? Returns the activity and reasons when blocked.
 *
 * `listed` says whether the viewer may know the activity exists: it is in their course outline,
 * or it is a stealth activity opened by link whose unmet conditions they are shown. Viewers who
 * can neither open nor manage an unlisted activity should not learn even its name.
 */
export async function getActivityAccess(ctx: RequestContext, activityId: string) {
  const a = await ctx.db.activity.findUnique({ where: { id: activityId } });
  if (!a) throw new NotFoundError('Activity');
  const access = await getCourseAccess(ctx, a.courseId);
  // Unlisted (stealth) activities still obey their section and restrictions when opened by link.
  const outline = access.canView
    ? await getCourseOutline(ctx, a.courseId, { includeUnlisted: true })
    : [];
  const entry = outline.flatMap((s) => s.activities).find((x) => x.activity.id === a.id);
  const moduleDisabled = !isModuleEnabled(await getAllSettings(ctx.db), a.moduleKey);
  const canOpen =
    !a.deletedAt &&
    !moduleDisabled &&
    access.canView &&
    (access.canManageActivities || access.canViewHidden || (entry?.available ?? false)) &&
    ((await ctx.perm.can('activity:view', a.id)) || access.isGuest || access.canManageActivities);
  // Hidden activities and "hide entirely" restrictions reveal neither the name nor the conditions.
  const listed =
    !!entry &&
    (entry.listed || (a.visibility === 'STEALTH' && entry.availabilityMissing.length > 0));
  return {
    activity: a,
    course: access.course,
    access,
    canOpen,
    listed,
    /** Its type is turned off: nobody opens it; editors are told why. */
    moduleDisabled,
    /** Whether the user meets the restrictions (editors may open it anyway). */
    available: entry?.available ?? false,
    completion: entry?.completion ?? null,
    missing: entry && listed ? entry.availabilityMissing : [],
  };
}
