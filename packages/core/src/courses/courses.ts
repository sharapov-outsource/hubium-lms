import { type Course, type Db, opNow, Prisma, SYSTEM_CONTEXT_ID, uuidv7 } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { msg } from '@hubium/module-sdk';
import { FileInput } from '@hubium/module-sdk/inputs';
import { z } from 'zod';
import type { Capability } from '../access/capabilities.ts';
import { createContext } from '../access/contexts.ts';
import { loadUserAccess, Permissions, rolesWithCap } from '../access/permissions.ts';
import { scheduleCourseProgress } from '../completion/schedule.ts';
import type { RequestContext } from '../context.ts';
import { logEnrolments } from '../enrol/enrol.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { fileUrl, storeFile } from '../files/files.ts';
import { ensureCourseGradebook } from '../grades/gradebook.ts';
import { rankBetween } from '../lib/rank.ts';
import { localeCode, optionalText } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';
import { ensureDefaultQuestionCategory } from '../questions/bank.ts';
import { getAllSettings } from '../settings/settings.ts';
import { checkCourseValues, courseFieldFilters } from './course-fields.ts';
import { purgeCourseRecord } from './recyclebin.ts';
import { rankAtEnd, rankForStep, sectionItems } from './section-items.ts';

type Tx = Prisma.TransactionClient | Db;

const dateish = z
  .union([z.string(), z.date(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'errors.field.invalidDate' });
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
  /** Values of custom course fields by short name; fields left out keep their values. */
  customFields: z.record(z.string(), z.unknown()).optional(),
});

export const createCourse = defineOperation({
  name: 'course.create',
  offline: 'online',
  input: CourseInput,
  authorize: (ctx, i) => ctx.perm.require('course:create', i.categoryId),
  async handler(ctx, input) {
    await shortNameFree(ctx.tx, input.shortName);
    if (
      input.idNumber &&
      (await ctx.tx.course.findUnique({ where: { idNumber: input.idNumber } }))
    ) {
      throw new ValidationError({ idNumber: [msg('errors.courses.idNumberInUse')] });
    }
    if (input.startDate && input.endDate && input.endDate <= input.startDate) {
      throw new ValidationError({ endDate: [msg('errors.courses.endBeforeStart')] });
    }
    const customFields = input.customFields
      ? await checkCourseValues(ctx, ctx.tx, input.customFields, {}, input.categoryId)
      : {};
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
        customFields,
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
    // the gradebook and the question bank are there from the start: pages only read them
    await ensureCourseGradebook(ctx.tx, id);
    await ensureDefaultQuestionCategory(ctx.tx, id);
    // The creator becomes the course teacher unless they already manage it from above.
    if (userId && !ctx.perm.isSiteAdmin) {
      // a setting naming a role deleted before it was kept from that: the default role
      const role =
        (await ctx.tx.role.findUnique({ where: { shortName: settings['course.creatorRole'] } })) ??
        (await ctx.tx.role.findUnique({ where: { shortName: 'editingteacher' } }));
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
        await logEnrolments(ctx.tx, ctx, 'enrolled', id, [userId], {
          method: 'manual',
          roleId: role.id,
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
  offline: 'guarded',
  input: CourseInput.omit({ sections: true }).extend({ id: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('course:update', i.id),
  async handler(ctx, input) {
    const course = await ctx.tx.course.findUnique({ where: { id: input.id } });
    if (!course || course.deletedAt) throw new NotFoundError('Course');
    await shortNameFree(ctx.tx, input.shortName, course.id);
    if (input.startDate && input.endDate && input.endDate <= input.startDate) {
      throw new ValidationError({ endDate: [msg('errors.courses.endBeforeStart')] });
    }
    const customFields = input.customFields
      ? await checkCourseValues(ctx, ctx.tx, input.customFields, course.customFields, course.id)
      : undefined;
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
        customFields,
      },
    });
    // with tracking turned on, learners' progress so far
    if (input.enableCompletion && !course.enableCompletion)
      await scheduleCourseProgress(ctx.tx, course.id);
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

/** What a course's cover may be. */
export const COURSE_IMAGE = {
  maxBytes: 5 * 1024 * 1024,
  allowedTypes: /^image\/(png|jpeg|webp|gif)$/,
};

/** The course's cover, stored in its "image" area, or none. */
export const setCourseImage = defineOperation({
  name: 'course.image.set',
  offline: 'guarded',
  input: z.object({ courseId: z.string().uuid(), image: FileInput.nullable() }),
  authorize: (ctx, i) => ctx.perm.require('course:update', i.courseId),
  async handler(ctx, { courseId, image }) {
    const file = image
      ? await storeFile(ctx.tx, {
          contextId: courseId,
          component: 'course',
          area: 'image',
          ...image,
          ...COURSE_IMAGE,
          uploadedById: ctx.perm.userId,
          replace: true,
        })
      : null;
    await ctx.tx.course.update({
      where: { id: courseId },
      data: { imageFileId: file?.id ?? null },
    });
    return { fileId: file?.id ?? null };
  },
});

/** A picture put in a text of the course with the editor, stored in its "editor" area. */
export const storeEditorImage = defineOperation({
  name: 'course.editorImage.store',
  offline: 'replay',
  input: FileInput.extend({ courseId: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('course:manageactivities', i.courseId),
  async handler(ctx, { courseId, ...image }) {
    const f = await storeFile(ctx.tx, {
      contextId: courseId,
      component: 'course',
      area: 'editor',
      path: `/${ctx.now.getTime()}/`,
      ...image,
      uploadedById: ctx.perm.userId,
      ...EDITOR_IMAGE,
    });
    return { url: fileUrl(f) };
  },
});

/** What a picture put in a text with the editor may be. */
export const EDITOR_IMAGE = {
  maxBytes: 10 * 1024 * 1024,
  allowedTypes: /^image\/(png|jpeg|gif|webp)$/,
};

/** Refuses a short name another course has, saying when that course is in the recycle bin:
 *  the name is free once it is deleted for good there. */
async function shortNameFree(tx: Prisma.TransactionClient, shortName: string, id?: string) {
  const other = await tx.course.findUnique({
    where: { shortName },
    select: { id: true, deletedAt: true },
  });
  if (!other || other.id === id) return;
  throw new ValidationError({
    shortName: [
      other.deletedAt ? msg('errors.courses.shortNameInBin') : msg('errors.courses.shortNameTaken'),
    ],
  });
}

/** Moves the course to the recycle bin (soft delete). */
export const deleteCourse = defineOperation({
  name: 'course.delete',
  offline: 'online',
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

/** Deletes a course in the recycle bin for good, with everything in it. */
export const purgeCourse = defineOperation({
  name: 'course.purge',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('course:delete', i.id),
  async handler(ctx, { id }) {
    const c = await ctx.tx.course.findUnique({ where: { id } });
    if (!c) throw new NotFoundError('Course');
    if (!c.deletedAt)
      throw new ValidationError({
        id: [msg('errors.courses.purgeBinnedCourse')],
      });
    await purgeCourseRecord(ctx, ctx.tx, id);
    await logEvent(ctx.tx, {
      name: 'course.purged',
      actorId: ctx.perm.userId,
      objectType: 'course',
      objectId: id,
      data: { shortName: c.shortName, fullName: c.fullName },
      origin: ctx.origin,
    });
    return { id };
  },
});

export const restoreCourse = defineOperation({
  name: 'course.restore',
  offline: 'online',
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
  if (!access.canView) throw new ForbiddenError(msg('errors.courses.cannotView'));
  return access;
}

// ── sections ──────────────────────────────────────────────────────────────────

/** The section a subsection goes into: a section of this course, not itself a subsection. */
async function parentSection(tx: Prisma.TransactionClient, courseId: string, parentId: string) {
  const parent = await tx.courseSection.findUnique({ where: { id: parentId } });
  if (!parent || parent.courseId !== courseId)
    throw new ValidationError({ parentId: [msg('errors.courses.unknownSection')] });
  if (parent.parentId)
    throw new ValidationError({ parentId: [msg('errors.courses.nestedSubsection')] });
  return parent;
}

/**
 * Adds a section to the course (after another one, or at the end), or with `parentId` a
 * subsection at the end of that section.
 */
export const addSection = defineOperation({
  name: 'section.add',
  offline: 'replay',
  input: z.object({
    courseId: z.string().uuid(),
    afterSectionId: z.string().uuid().optional(),
    parentId: z.string().uuid().optional(),
    title: z.string().trim().max(255).default(''),
  }),
  authorize: (ctx, i) => ctx.perm.require('course:manageactivities', i.courseId),
  async handler(ctx, input) {
    if (input.parentId) {
      const parent = await parentSection(ctx.tx, input.courseId, input.parentId);
      const s = await ctx.tx.courseSection.create({
        data: {
          courseId: input.courseId,
          parentId: parent.id,
          rank: await rankAtEnd(ctx.tx, parent.id),
          title: input.title,
        },
      });
      return { id: s.id };
    }
    const sections = await ctx.tx.courseSection.findMany({
      where: { courseId: input.courseId, parentId: null },
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
  offline: 'guarded',
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
      if (!r.success)
        throw new ValidationError({ availability: [msg('errors.courses.invalidRestrictions')] });
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
  offline: 'guarded',
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

/** Moves a section one place among the course's sections, a subsection among its section's items. */
export const moveSection = defineOperation({
  name: 'section.move',
  offline: 'guarded',
  input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
  async authorize(ctx, i) {
    const s = await ctx.db.courseSection.findUniqueOrThrow({ where: { id: i.id } });
    await ctx.perm.require('course:manageactivities', s.courseId);
  },
  async handler(ctx, { id, direction }) {
    const s = await ctx.tx.courseSection.findUniqueOrThrow({ where: { id } });
    if (s.parentId) {
      const rank = rankForStep(await sectionItems(ctx.tx, s.parentId), id, direction);
      if (rank) await ctx.tx.courseSection.update({ where: { id }, data: { rank } });
      return { id };
    }
    const all = await ctx.tx.courseSection.findMany({
      where: { courseId: s.courseId, parentId: null },
      orderBy: { rank: 'asc' },
    });
    const i = all.findIndex((x) => x.id === id);
    // Section 0 (general) stays first.
    if (i === 0) throw new ValidationError({ id: [msg('errors.courses.generalNotMovable')] });
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

/** Moves a subsection, with its activities, to the end of another section. */
export const moveSubsection = defineOperation({
  name: 'section.moveTo',
  offline: 'guarded',
  input: z.object({ id: z.string().uuid(), parentId: z.string().uuid() }),
  async authorize(ctx, i) {
    const s = await ctx.db.courseSection.findUniqueOrThrow({ where: { id: i.id } });
    await ctx.perm.require('course:manageactivities', s.courseId);
  },
  async handler(ctx, { id, parentId }) {
    const s = await ctx.tx.courseSection.findUniqueOrThrow({ where: { id } });
    if (!s.parentId) throw new ValidationError({ id: [msg('errors.courses.onlySubsectionMoves')] });
    if (s.parentId === parentId) return { id };
    const parent = await parentSection(ctx.tx, s.courseId, parentId);
    await ctx.tx.courseSection.update({
      where: { id },
      data: { parentId: parent.id, rank: await rankAtEnd(ctx.tx, parent.id) },
    });
    return { id };
  },
});

export const deleteSection = defineOperation({
  name: 'section.delete',
  offline: 'guarded',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const s = await ctx.db.courseSection.findUniqueOrThrow({ where: { id: i.id } });
    await ctx.perm.require('course:manageactivities', s.courseId);
  },
  async handler(ctx, { id }) {
    const s = await ctx.tx.courseSection.findUniqueOrThrow({ where: { id } });
    const first = await ctx.tx.courseSection.findFirst({
      where: { courseId: s.courseId, parentId: null },
      orderBy: { rank: 'asc' },
    });
    if (first?.id === id)
      throw new ValidationError({ id: [msg('errors.courses.generalNotDeletable')] });
    const live = await ctx.tx.activity.count({ where: { sectionId: id, deletedAt: null } });
    if (live) throw new ValidationError({ id: [msg('errors.courses.sectionHasActivities')] });
    if (await ctx.tx.courseSection.count({ where: { parentId: id } }))
      throw new ValidationError({ id: [msg('errors.courses.sectionHasSubsections')] });
    // What is in the recycle bin stays there, in the general section, to be restored or
    // deleted for good as any other: not wiped with the section, past the modules' clean-up.
    const binned = await ctx.tx.activity.findMany({
      where: { sectionId: id },
      orderBy: { rank: 'asc' },
      select: { id: true },
    });
    for (const a of binned)
      await ctx.tx.activity.update({
        where: { id: a.id },
        data: { sectionId: first!.id, rank: await rankAtEnd(ctx.tx, first!.id) },
      });
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
  /** Stored custom field values (all of them: callers pick what to show). */
  customFields: unknown;
}

/**
 * Courses (not in the recycle bin) matching `where` in which the person holds `cap`, by name,
 * at most `take`. Only the courses within reach of their roles are looked at (the course, a
 * category above it, the site when a role there allows `cap`), and can() decides among them,
 * so overrides and prohibitions count and a match past the first page of the site is found.
 */
export async function coursesWithCap<S extends Prisma.CourseSelect & { id: true }>(
  ctx: RequestContext,
  cap: Capability,
  opts: { where?: Prisma.CourseWhereInput; select: S; take: number },
): Promise<Prisma.CourseGetPayload<{ select: S }>[]> {
  const userId = ctx.perm.userId;
  if (!userId) return [];
  let reach: Prisma.CourseWhereInput = {};
  if (!ctx.perm.isSiteAdmin) {
    const [held, siteRoles] = await Promise.all([
      ctx.db.roleAssignment.findMany({
        where: { userId },
        select: { contextId: true, roleId: true },
      }),
      rolesWithCap(ctx.db, cap, SYSTEM_CONTEXT_ID),
    ]);
    const everywhere = held.some(
      (h) => h.contextId === SYSTEM_CONTEXT_ID && siteRoles.includes(h.roleId),
    );
    const ids = [...new Set(held.map((h) => h.contextId))].filter((c) => c !== SYSTEM_CONTEXT_ID);
    if (!everywhere)
      reach = { context: { OR: [{ id: { in: ids } }, { ancestorIds: { hasSome: ids } }] } };
  }
  const out: Prisma.CourseGetPayload<{ select: S }>[] = [];
  const BATCH = 200;
  for (let skip = 0; out.length < opts.take; skip += BATCH) {
    const batch = await ctx.db.course.findMany({
      where: { AND: [{ deletedAt: null }, reach, opts.where ?? {}] },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      skip,
      take: BATCH,
      select: opts.select,
    });
    for (const c of batch) {
      if (out.length >= opts.take) break;
      if (await ctx.perm.can(cap, (c as { id: string }).id).catch(() => false)) out.push(c);
    }
    if (batch.length < BATCH) break;
  }
  return out;
}

/**
 * Courses the user may open now through an active enrolment, most recently accessed first.
 * Hidden courses only for those who see hidden courses (teachers preparing them), as the
 * course page itself.
 */
export async function listMyCourses(db: Db, userId: string, now = new Date()): Promise<MyCourse[]> {
  let enrolments = await db.enrolment.findMany({
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
  const hidden = enrolments.filter((e) => !e.course.visible).map((e) => e.courseId);
  if (hidden.length) {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, isSiteAdmin: true },
    });
    const perm = new Permissions(db, await loadUserAccess(db, user, { now }));
    const unseen = new Set<string>();
    for (const id of new Set(hidden))
      if (!(await perm.can('course:viewhidden', id))) unseen.add(id);
    enrolments = enrolments.filter((e) => !unseen.has(e.courseId));
  }
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
      customFields: c.customFields,
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
    create: { userId, courseId, lastAccessAt: opNow(), lastActivityId: activityId ?? null },
    update: { lastAccessAt: opNow(), ...(activityId ? { lastActivityId: activityId } : {}) },
  });
}

export const CatalogQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(12),
  /** Visible menu and checkbox course fields: a choice, or yes / no. */
  fields: z.record(z.string(), z.string().max(100)).optional(),
});

/** Words of a search query for to_tsquery: letters and digits only, ё → е. */
export function searchTerms(q: string): string[] {
  return (
    q
      .toLowerCase()
      .replaceAll('ё', 'е')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, 8);
}

/**
 * Ids of catalog courses matching `q`, best first: full text in the languages of the
 * installed packs with prefixes and without accents (every word must match), or the name
 * containing the query, or a name close to it (typos).
 */
async function matchCourses(db: Db, q: string): Promise<string[]> {
  const terms = searchTerms(q);
  const query = terms.length
    ? Prisma.join(
        terms.map((t) => Prisma.sql`hubium_prefix_query(${t})`),
        ' && ',
      )
    : null;
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id
      FROM "Course" c
     WHERE c."deletedAt" IS NULL AND c.visible
       AND (${query ? Prisma.sql`c.tsv @@ (${query})` : Prisma.sql`false`}
            OR unaccent(c."fullName") ILIKE unaccent(${like}) OR c."shortName"::text ILIKE ${like}
            OR c."fullName" % ${q})
     ORDER BY ${query ? Prisma.sql`ts_rank_cd(c.tsv, ${query})` : Prisma.sql`0`}
              + similarity(c."fullName", ${q}) DESC, c."fullName"
     LIMIT 500`;
  return rows.map((r) => r.id);
}

/** Visible courses for the catalog: full-text search, or newest first without a query. */
export async function searchCatalog(ctx: RequestContext, raw: z.input<typeof CatalogQuery>) {
  const { q, categoryId, page, pageSize, fields } = CatalogQuery.parse(raw);
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
    AND: fields ? await courseFieldFilters(ctx.db, fields) : [],
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
