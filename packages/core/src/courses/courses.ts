import { type Course, type Db, Prisma, uuidv7 } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { z } from 'zod';
import { createContext } from '../access/contexts.ts';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { rankBetween } from '../lib/rank.ts';
import { localeCode, optionalText } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings } from '../settings/settings.ts';

type Tx = Prisma.TransactionClient | Db;

const dateish = z
  .union([z.string(), z.date(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Invalid date' });
      return z.NEVER;
    }
    return d;
  });

export const CourseInput = z.object({
  categoryId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(255),
  shortName: z.string().trim().min(1).max(100),
  idNumber: optionalText(100),
  summary: z.string().max(100_000).default(''),
  format: z.enum(['TOPICS', 'WEEKS', 'SINGLE']).default('TOPICS'),
  sections: z.coerce.number().int().min(0).max(52).default(4),
  startDate: dateish,
  endDate: dateish,
  visible: z.boolean().default(true),
  /** Forced language of the course pages; null lets each user's language apply. */
  lang: localeCode
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  enableCompletion: z.boolean().default(true),
  groupMode: z.enum(['NONE', 'SEPARATE', 'VISIBLE']).default('NONE'),
  groupModeForced: z.boolean().default(false),
  guestAccess: z.boolean().default(false),
});

export const createCourse = defineOperation({
  name: 'course.create',
  input: CourseInput,
  authorize: (ctx, i) => ctx.perm.require('course:create', i.categoryId),
  async handler(ctx, input) {
    if (await ctx.tx.course.findUnique({ where: { shortName: input.shortName } })) {
      throw new ValidationError({ shortName: ['Short name is already used by another course'] });
    }
    if (
      input.idNumber &&
      (await ctx.tx.course.findUnique({ where: { idNumber: input.idNumber } }))
    ) {
      throw new ValidationError({ idNumber: ['ID number already in use'] });
    }
    if (input.startDate && input.endDate && input.endDate <= input.startDate) {
      throw new ValidationError({ endDate: ['End date must be after the start date'] });
    }
    const id = uuidv7();
    await createContext(ctx.tx, id, 'COURSE', input.categoryId);
    const userId = ctx.perm.userId;
    await ctx.tx.course.create({
      data: {
        id,
        categoryId: input.categoryId,
        fullName: input.fullName,
        shortName: input.shortName,
        idNumber: input.idNumber,
        summary: sanitizeRichText(input.summary),
        format: input.format,
        startDate: input.startDate,
        endDate: input.endDate,
        visible: input.visible,
        lang: input.lang ?? null,
        enableCompletion: input.enableCompletion,
        groupMode: input.groupMode,
        groupModeForced: input.groupModeForced,
        guestAccess: input.guestAccess,
        createdById: userId,
      },
    });
    // Section 0 ("general") plus N topic/week sections.
    let prev: string | null = null;
    const count = input.format === 'SINGLE' ? 1 : input.sections + 1;
    for (let i = 0; i < count; i++) {
      prev = rankBetween(prev, null);
      await ctx.tx.courseSection.create({ data: { courseId: id, rank: prev, title: '' } });
    }
    const [student, settings] = await Promise.all([
      ctx.tx.role.findUniqueOrThrow({ where: { shortName: 'student' } }),
      getAllSettings(ctx.db),
    ]);
    await ctx.tx.enrolmentMethod.createMany({
      data: [
        { courseId: id, type: 'MANUAL', roleId: student.id, sortOrder: 0 },
        { courseId: id, type: 'SELF', roleId: student.id, enabled: false, sortOrder: 1 },
      ],
    });
    // The creator becomes the course teacher unless they already manage it from above.
    if (userId && !ctx.perm.isSiteAdmin) {
      const role = await ctx.tx.role.findUnique({
        where: { shortName: settings['course.creatorRole'] },
      });
      if (role) {
        const manual = await ctx.tx.enrolmentMethod.findFirstOrThrow({
          where: { courseId: id, type: 'MANUAL' },
        });
        const enrolment = await ctx.tx.enrolment.create({
          data: { methodId: manual.id, courseId: id, userId, createdById: userId },
        });
        await ctx.tx.roleAssignment.create({
          data: {
            userId,
            roleId: role.id,
            contextId: id,
            component: 'ENROL',
            enrolmentId: enrolment.id,
          },
        });
      }
    }
    await logEvent(ctx.tx, {
      name: 'course.created',
      actorId: userId,
      courseId: id,
      contextId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

export const updateCourse = defineOperation({
  name: 'course.update',
  input: CourseInput.omit({ sections: true }).extend({ id: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('course:update', i.id),
  async handler(ctx, input) {
    const course = await ctx.tx.course.findUnique({ where: { id: input.id } });
    if (!course || course.deletedAt) throw new NotFoundError('Course');
    if (input.shortName.toLowerCase() !== course.shortName.toLowerCase()) {
      if (await ctx.tx.course.findUnique({ where: { shortName: input.shortName } })) {
        throw new ValidationError({ shortName: ['Short name is already used by another course'] });
      }
    }
    if (input.startDate && input.endDate && input.endDate <= input.startDate) {
      throw new ValidationError({ endDate: ['End date must be after the start date'] });
    }
    if (input.categoryId !== course.categoryId) {
      await ctx.perm.require('course:create', input.categoryId);
      const { moveContext } = await import('../access/contexts.ts');
      await moveContext(ctx.tx, course.id, input.categoryId);
    }
    await ctx.tx.course.update({
      where: { id: course.id },
      data: {
        categoryId: input.categoryId,
        fullName: input.fullName,
        shortName: input.shortName,
        idNumber: input.idNumber ?? null,
        summary: sanitizeRichText(input.summary),
        format: input.format,
        startDate: input.startDate,
        endDate: input.endDate,
        visible: input.visible,
        lang: input.lang ?? null,
        enableCompletion: input.enableCompletion,
        groupMode: input.groupMode,
        groupModeForced: input.groupModeForced,
        guestAccess: input.guestAccess,
      },
    });
    // A forced group mode applies to every activity of the course.
    if (input.groupModeForced)
      await ctx.tx.activity.updateMany({
        where: { courseId: course.id },
        data: { groupMode: input.groupMode },
      });
    await logEvent(ctx.tx, {
      name: 'course.updated',
      actorId: ctx.perm.userId,
      courseId: course.id,
      origin: ctx.origin,
    });
    return { id: course.id };
  },
});

export const setCourseImage = async (
  ctx: RequestContext,
  courseId: string,
  fileId: string | null,
) => {
  await ctx.perm.require('course:update', courseId);
  await ctx.db.course.update({ where: { id: courseId }, data: { imageFileId: fileId } });
};

/** Moves the course to the recycle bin (soft delete). */
export const deleteCourse = defineOperation({
  name: 'course.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('course:delete', i.id),
  async handler(ctx, { id }) {
    await ctx.tx.course.update({ where: { id }, data: { deletedAt: ctx.now } });
    await logEvent(ctx.tx, {
      name: 'course.deleted',
      actorId: ctx.perm.userId,
      courseId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

export const restoreCourse = defineOperation({
  name: 'course.restore',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('course:delete', i.id),
  async handler(ctx, { id }) {
    await ctx.tx.course.update({ where: { id }, data: { deletedAt: null } });
    return { id };
  },
});

// ── access ────────────────────────────────────────────────────────────────────

export interface CourseAccess {
  course: Course;
  canView: boolean;
  canEdit: boolean;
  canManageActivities: boolean;
  canViewHidden: boolean;
  canViewParticipants: boolean;
  canManageEnrolments: boolean;
  canManageGroups: boolean;
  canViewReports: boolean;
  canViewAllGrades: boolean;
  isEnrolled: boolean;
  isGuest: boolean;
  enrolmentId: string | null;
}

export async function getCourseAccess(
  ctx: RequestContext,
  courseId: string,
): Promise<CourseAccess> {
  const course = await ctx.db.course.findUnique({ where: { id: courseId } });
  if (!course) throw new NotFoundError('Course');
  const userId = ctx.perm.userId;
  const now = ctx.now;
  const enrolment = userId
    ? await ctx.db.enrolment.findFirst({
        where: {
          courseId,
          userId,
          status: 'ACTIVE',
          method: { enabled: true },
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          ],
        },
      })
    : null;
  const [
    canViewHidden,
    canEdit,
    canManageActivities,
    canViewCourse,
    canViewParticipants,
    canManageEnrolments,
    canManageGroups,
    canViewReports,
    canViewAllGrades,
  ] = await Promise.all([
    ctx.perm.can('course:viewhidden', courseId),
    ctx.perm.can('course:update', courseId),
    ctx.perm.can('course:manageactivities', courseId),
    ctx.perm.can('course:view', courseId),
    ctx.perm.can('course:viewparticipants', courseId),
    ctx.perm.can('enrol:manage', courseId),
    ctx.perm.can('group:manage', courseId),
    ctx.perm.can('report:view', courseId),
    ctx.perm.can('grade:viewall', courseId),
  ]);
  const isGuest = !enrolment && course.guestAccess && !canViewCourse;
  const deleted = !!course.deletedAt;
  const visibleToViewer = course.visible || canViewHidden;
  const canView =
    !deleted && visibleToViewer && (!!enrolment || canViewCourse || course.guestAccess);
  return {
    course,
    canView,
    canEdit: !deleted && canEdit,
    canManageActivities: !deleted && canManageActivities,
    canViewHidden,
    canViewParticipants,
    canManageEnrolments,
    canManageGroups,
    canViewReports,
    canViewAllGrades,
    isEnrolled: !!enrolment,
    isGuest,
    enrolmentId: enrolment?.id ?? null,
  };
}

export async function requireCourseView(
  ctx: RequestContext,
  courseId: string,
): Promise<CourseAccess> {
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canView) throw new ForbiddenError('You cannot view this course');
  return access;
}

// ── sections ──────────────────────────────────────────────────────────────────

export const addSection = defineOperation({
  name: 'section.add',
  input: z.object({
    courseId: z.string().uuid(),
    afterSectionId: z.string().uuid().optional(),
    title: z.string().max(255).default(''),
  }),
  authorize: (ctx, i) => ctx.perm.require('course:manageactivities', i.courseId),
  async handler(ctx, input) {
    const sections = await ctx.tx.courseSection.findMany({
      where: { courseId: input.courseId },
      orderBy: { rank: 'asc' },
    });
    const idx = input.afterSectionId
      ? sections.findIndex((s) => s.id === input.afterSectionId)
      : sections.length - 1;
    const before = sections[idx]?.rank ?? null;
    const after = sections[idx + 1]?.rank ?? null;
    const s = await ctx.tx.courseSection.create({
      data: { courseId: input.courseId, rank: rankBetween(before, after), title: input.title },
    });
    return { id: s.id };
  },
});

export const updateSection = defineOperation({
  name: 'section.update',
  input: z.object({
    id: z.string().uuid(),
    title: z.string().trim().max(255),
    summary: z.string().max(100_000).default(''),
    visible: z.boolean().optional(),
    availability: z.unknown().optional(),
  }),
  async authorize(ctx, i) {
    const s = await ctx.db.courseSection.findUnique({ where: { id: i.id } });
    if (!s) throw new NotFoundError('Section');
    await ctx.perm.require('course:manageactivities', s.courseId);
  },
  async handler(ctx, input) {
    const { AvailabilityTreeSchema } = await import('./availability.ts');
    let availability: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
    if (
      input.availability !== undefined &&
      input.availability !== null &&
      input.availability !== ''
    ) {
      const raw =
        typeof input.availability === 'string'
          ? JSON.parse(input.availability)
          : input.availability;
      const r = AvailabilityTreeSchema.safeParse(raw);
      if (!r.success) throw new ValidationError({ availability: ['Invalid access restrictions'] });
      if (r.data.c.length) availability = r.data as unknown as Prisma.InputJsonValue;
    }
    await ctx.tx.courseSection.update({
      where: { id: input.id },
      data: {
        title: input.title,
        summary: sanitizeRichText(input.summary),
        ...(input.visible !== undefined ? { visible: input.visible } : {}),
        ...(input.availability !== undefined ? { availability } : {}),
      },
    });
    return { id: input.id };
  },
});

export const setSectionVisible = defineOperation({
  name: 'section.visibility',
  input: z.object({ id: z.string().uuid(), visible: z.boolean() }),
  async authorize(ctx, i) {
    const s = await ctx.db.courseSection.findUniqueOrThrow({ where: { id: i.id } });
    await ctx.perm.require('course:manageactivities', s.courseId);
  },
  async handler(ctx, { id, visible }) {
    await ctx.tx.courseSection.update({ where: { id }, data: { visible } });
    return { id };
  },
});

export const moveSection = defineOperation({
  name: 'section.move',
  input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
  async authorize(ctx, i) {
    const s = await ctx.db.courseSection.findUniqueOrThrow({ where: { id: i.id } });
    await ctx.perm.require('course:manageactivities', s.courseId);
  },
  async handler(ctx, { id, direction }) {
    const s = await ctx.tx.courseSection.findUniqueOrThrow({ where: { id } });
    const all = await ctx.tx.courseSection.findMany({
      where: { courseId: s.courseId },
      orderBy: { rank: 'asc' },
    });
    const i = all.findIndex((x) => x.id === id);
    // Section 0 (general) stays first.
    if (i === 0) throw new ValidationError({ id: ['The general section cannot be moved'] });
    if (direction === 'up') {
      if (i <= 1) return { id };
      const rank = rankBetween(all[i - 2]!.rank, all[i - 1]!.rank);
      await ctx.tx.courseSection.update({ where: { id }, data: { rank } });
    } else {
      if (i >= all.length - 1) return { id };
      const rank = rankBetween(all[i + 1]!.rank, all[i + 2]?.rank ?? null);
      await ctx.tx.courseSection.update({ where: { id }, data: { rank } });
    }
    return { id };
  },
});

export const deleteSection = defineOperation({
  name: 'section.delete',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const s = await ctx.db.courseSection.findUniqueOrThrow({ where: { id: i.id } });
    await ctx.perm.require('course:manageactivities', s.courseId);
  },
  async handler(ctx, { id }) {
    const s = await ctx.tx.courseSection.findUniqueOrThrow({ where: { id } });
    const first = await ctx.tx.courseSection.findFirst({
      where: { courseId: s.courseId },
      orderBy: { rank: 'asc' },
    });
    if (first?.id === id)
      throw new ValidationError({ id: ['The general section cannot be deleted'] });
    const live = await ctx.tx.activity.count({ where: { sectionId: id, deletedAt: null } });
    if (live)
      throw new ValidationError({ id: ['Move or delete the activities in this section first'] });
    await ctx.tx.activity.deleteMany({ where: { sectionId: id } });
    await ctx.tx.courseSection.delete({ where: { id } });
    return { id };
  },
});

// ── listings ──────────────────────────────────────────────────────────────────

export interface MyCourse {
  id: string;
  fullName: string;
  shortName: string;
  summary: string;
  idNumber: string | null;
  imageFileId: string | null;
  categoryId: string;
  categoryName: string;
  visible: boolean;
  progress: number | null;
  lastAccessAt: Date | null;
  role: string | null;
  startDate: Date | null;
  endDate: Date | null;
}

/** Courses the user is actively enrolled in, most recently accessed first. */
export async function listMyCourses(db: Tx, userId: string, now = new Date()): Promise<MyCourse[]> {
  const enrolments = await db.enrolment.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      method: { enabled: true },
      course: { deletedAt: null },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    include: { course: { include: { category: { select: { name: true } } } } },
  });
  const courseIds = [...new Set(enrolments.map((e) => e.courseId))];
  const [accesses, completions, roles] = await Promise.all([
    db.courseAccess.findMany({ where: { userId, courseId: { in: courseIds } } }),
    db.courseCompletion.findMany({ where: { userId, courseId: { in: courseIds } } }),
    db.roleAssignment.findMany({
      where: { userId, contextId: { in: courseIds } },
      include: { role: { select: { shortName: true, sortOrder: true } } },
    }),
  ]);
  const seen = new Set<string>();
  const out: MyCourse[] = [];
  for (const e of enrolments) {
    if (seen.has(e.courseId)) continue;
    seen.add(e.courseId);
    const c = e.course;
    const roleRows = roles
      .filter((r) => r.contextId === c.id)
      .sort((a, b) => a.role.sortOrder - b.role.sortOrder);
    const isLearner = roleRows.some((r) => r.role.shortName === 'student');
    out.push({
      id: c.id,
      fullName: c.fullName,
      shortName: c.shortName,
      summary: c.summary,
      idNumber: c.idNumber,
      imageFileId: c.imageFileId,
      categoryId: c.categoryId,
      categoryName: c.category.name,
      visible: c.visible,
      progress:
        c.enableCompletion && isLearner
          ? (completions.find((x) => x.courseId === c.id)?.progressPercent ?? 0)
          : null,
      lastAccessAt: accesses.find((a) => a.courseId === c.id)?.lastAccessAt ?? null,
      role: roleRows[0]?.role.shortName ?? null,
      startDate: c.startDate,
      endDate: c.endDate,
    });
  }
  return out.sort(
    (a, b) =>
      (b.lastAccessAt?.getTime() ?? 0) - (a.lastAccessAt?.getTime() ?? 0) ||
      a.fullName.localeCompare(b.fullName),
  );
}

export async function recordCourseAccess(
  db: Tx,
  userId: string,
  courseId: string,
  activityId?: string,
): Promise<void> {
  await db.courseAccess.upsert({
    where: { userId_courseId: { userId, courseId } },
    create: { userId, courseId, lastAccessAt: new Date(), lastActivityId: activityId ?? null },
    update: { lastAccessAt: new Date(), ...(activityId ? { lastActivityId: activityId } : {}) },
  });
}

export const CatalogQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(12),
});

/** Words of a search query, normalised for to_tsquery (letters and digits only, ё → е). */
export function searchTerms(q: string): string[] {
  return (
    q
      .toLowerCase()
      .replaceAll('ё', 'е')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, 8);
}

/**
 * Ids of catalog courses matching `q`, best first: full text in Russian and English with
 * prefixes (every word must match), or the name containing the query, or a name close to
 * it (typos).
 */
async function matchCourses(db: Db, q: string): Promise<string[]> {
  const terms = searchTerms(q);
  const query = terms.length
    ? Prisma.join(
        terms.map(
          (t) =>
            Prisma.sql`(to_tsquery('russian', ${`${t}:*`}) || to_tsquery('english', ${`${t}:*`}) || to_tsquery('simple', ${`${t}:*`}))`,
        ),
        ' && ',
      )
    : null;
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id
      FROM "Course" c
     WHERE c."deletedAt" IS NULL AND c.visible
       AND (${query ? Prisma.sql`c.tsv @@ (${query})` : Prisma.sql`false`}
            OR c."fullName" ILIKE ${like} OR c."shortName"::text ILIKE ${like}
            OR c."fullName" % ${q})
     ORDER BY ${query ? Prisma.sql`ts_rank_cd(c.tsv, ${query})` : Prisma.sql`0`}
              + similarity(c."fullName", ${q}) DESC, c."fullName"
     LIMIT 500`;
  return rows.map((r) => r.id);
}

/** Visible courses for the catalog: full-text search, or newest first without a query. */
export async function searchCatalog(ctx: RequestContext, raw: z.input<typeof CatalogQuery>) {
  const { q, categoryId, page, pageSize } = CatalogQuery.parse(raw);
  let categoryIds: string[] | undefined;
  if (categoryId) {
    const descendants = await ctx.db.context.findMany({
      where: { OR: [{ id: categoryId }, { ancestorIds: { has: categoryId } }], level: 'CATEGORY' },
      select: { id: true },
    });
    categoryIds = descendants.map((d) => d.id);
  }
  const matched = q ? await matchCourses(ctx.db, q) : null;
  const where: Prisma.CourseWhereInput = {
    deletedAt: null,
    visible: true,
    category: { visible: true },
    ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
    ...(matched ? { id: { in: matched } } : {}),
  };
  const include = {
    category: { select: { id: true, name: true } },
    enrolmentMethods: { where: { enabled: true }, select: { type: true } },
  } satisfies Prisma.CourseInclude;
  if (matched) {
    // relevance order comes from the search; filters may drop some of the matches
    const found = await ctx.db.course.findMany({ where, include });
    const rank = new Map(matched.map((id, i) => [id, i]));
    found.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    return {
      total: found.length,
      items: found.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
    };
  }
  const [total, items] = await Promise.all([
    ctx.db.course.count({ where }),
    ctx.db.course.findMany({
      where,
      orderBy: [{ startDate: 'desc' }, { fullName: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include,
    }),
  ]);
  return { total, items, page, pageSize };
}
