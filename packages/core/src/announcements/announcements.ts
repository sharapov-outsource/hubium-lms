import { type Db, opNow, type Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { extractText, sanitizeRichText } from '@hubium/editor/server';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import { usersWithCap } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';
import { getCourseAccess } from '../courses/courses.ts';
import { activeCourseUserIds } from '../enrol/participants.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';

// Course stream (Classroom-like) and site-wide announcements. Scheduled announcements
// become visible at `publishAt`; the worker sends their notifications once (cron).

type Tx = Prisma.TransactionClient;

const isoDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v ? new Date(v) : null))
  .refine((v) => v === null || !Number.isNaN(v.getTime()), 'errors.field.invalidDate');

const AnnouncementInput = z.object({
  title: z.string().trim().min(1).max(255),
  contentHtml: z.string().max(200_000).default(''),
  pinned: z.boolean().default(false),
  notify: z.boolean().default(true),
  publishAt: isoDate,
  groupId: z.string().uuid().nullish(),
});

async function authorizeScope(ctx: RequestContext, courseId: string | null | undefined) {
  if (courseId) await ctx.perm.require('announcement:post', courseId);
  else await ctx.perm.require('site:config', SYSTEM_CONTEXT_ID);
}

/** Sends the notifications of a published announcement once. */
export async function notifyAnnouncement(tx: Tx, id: string, now = opNow()): Promise<number> {
  const a = await tx.announcement.findUnique({
    where: { id },
    include: { course: { select: { fullName: true, visible: true } } },
  });
  if (!a || a.notifiedAt || !a.notify || a.publishAt > now) return 0;
  // The cron and an edit may race: only the one that claims the row sends.
  const claimed = await tx.announcement.updateMany({
    where: { id, notifiedAt: null },
    data: { notifiedAt: now },
  });
  if (!claimed.count) return 0;
  let recipients = a.courseId
    ? await activeCourseUserIds(tx, a.courseId, { groupId: a.groupId, now })
    : (
        await tx.user.findMany({
          where: { status: 'ACTIVE', kind: 'PERSON' },
          select: { id: true },
        })
      ).map((u) => u.id);
  if (a.courseId && a.course && !a.course.visible) {
    // Learners cannot open a hidden course; only its staff hear about it.
    const staff = new Set(await usersWithCap(tx as Db, 'course:viewhidden', a.courseId));
    recipients = recipients.filter((u) => staff.has(u));
  }
  const body = extractText(a.contentHtml).slice(0, 500);
  return notifyUsers(tx, recipients, {
    type: a.courseId ? 'announcement.course' : 'announcement.site',
    title: a.course
      ? {
          key: 'notifications.text.announcementCourse',
          values: { course: a.course.fullName, title: a.title },
        }
      : a.title,
    body,
    url: a.courseId ? `/course/${a.courseId}/stream#a-${a.id}` : `/dashboard#a-${a.id}`,
    courseId: a.courseId,
    actorId: a.authorId,
    data: { announcementId: a.id },
  });
}

/** Cron: notifications for scheduled announcements whose time has come. */
export async function publishDueAnnouncements(db: Db, now = new Date()): Promise<number> {
  const due = await db.announcement.findMany({
    where: { notify: true, notifiedAt: null, publishAt: { lte: now } },
    select: { id: true },
    take: 50,
  });
  let n = 0;
  for (const { id } of due) {
    await db.$transaction(async (tx) => {
      n += (await notifyAnnouncement(tx, id, now)) > 0 ? 1 : 0;
    });
  }
  return n;
}

export const createAnnouncement = defineOperation({
  name: 'announcement.create',
  offline: 'replay',
  mutation: true,
  input: AnnouncementInput.extend({ courseId: z.string().uuid().nullish() }),
  authorize: (ctx, i) => authorizeScope(ctx, i.courseId),
  async handler(ctx, input) {
    if (input.groupId) {
      const g = await ctx.tx.group.findUnique({ where: { id: input.groupId } });
      if (!g || g.courseId !== input.courseId) {
        throw new ValidationError({ groupId: [msg('errors.common.unknownGroup')] });
      }
    }
    const a = await ctx.tx.announcement.create({
      data: {
        courseId: input.courseId ?? null,
        groupId: input.courseId ? (input.groupId ?? null) : null,
        authorId: ctx.perm.userId ?? null,
        title: input.title,
        contentHtml: sanitizeRichText(input.contentHtml),
        pinned: input.pinned,
        notify: input.notify,
        publishAt: input.publishAt ?? ctx.now,
      },
    });
    await logEvent(ctx.tx, {
      name: 'announcement.created',
      actorId: ctx.perm.userId,
      courseId: input.courseId ?? null,
      objectId: a.id,
      origin: ctx.origin,
    });
    await notifyAnnouncement(ctx.tx, a.id, ctx.now);
    return { id: a.id };
  },
});

async function loadForEdit(ctx: RequestContext, id: string) {
  const a = await ctx.db.announcement.findUnique({ where: { id } });
  if (!a) throw new NotFoundError('Announcement');
  await authorizeScope(ctx, a.courseId);
  return a;
}

export const updateAnnouncement = defineOperation({
  name: 'announcement.update',
  offline: 'guarded',
  mutation: true,
  input: AnnouncementInput.extend({ id: z.string().uuid() }),
  authorize: async (ctx, i) => {
    await loadForEdit(ctx, i.id);
  },
  async handler(ctx, input) {
    const a = await ctx.tx.announcement.findUniqueOrThrow({ where: { id: input.id } });
    if (input.groupId && a.courseId) {
      const g = await ctx.tx.group.findUnique({ where: { id: input.groupId } });
      if (g?.courseId !== a.courseId)
        throw new ValidationError({ groupId: [msg('errors.common.unknownGroup')] });
    }
    await ctx.tx.announcement.update({
      where: { id: a.id },
      data: {
        title: input.title,
        contentHtml: sanitizeRichText(input.contentHtml),
        pinned: input.pinned,
        notify: input.notify,
        groupId: a.courseId ? (input.groupId ?? null) : null,
        // already published announcements keep their date
        ...(a.notifiedAt || a.publishAt <= ctx.now
          ? {}
          : { publishAt: input.publishAt ?? ctx.now }),
      },
    });
    await notifyAnnouncement(ctx.tx, a.id, ctx.now);
    return { id: a.id };
  },
});

export const deleteAnnouncement = defineOperation({
  name: 'announcement.delete',
  offline: 'guarded',
  mutation: true,
  input: z.object({ id: z.string().uuid() }),
  authorize: async (ctx, i) => {
    await loadForEdit(ctx, i.id);
  },
  async handler(ctx, { id }) {
    await ctx.tx.announcement.delete({ where: { id } });
    return { ok: true };
  },
});

export const pinAnnouncement = defineOperation({
  name: 'announcement.pin',
  offline: 'guarded',
  mutation: true,
  input: z.object({ id: z.string().uuid(), pinned: z.boolean() }),
  authorize: async (ctx, i) => {
    await loadForEdit(ctx, i.id);
  },
  async handler(ctx, { id, pinned }) {
    await ctx.tx.announcement.update({ where: { id }, data: { pinned } });
    return { ok: true };
  },
});

const include = {
  author: { select: { id: true, name: true, image: true } },
  group: { select: { id: true, name: true } },
} as const;

/**
 * Course stream, newest first, a page at a time: the pinned items head the first page, the
 * others follow by date, and `before` (the last item's id) gives the page after it. Managers
 * also see scheduled items.
 */
export async function listCourseAnnouncements(
  ctx: RequestContext,
  courseId: string,
  opts: { limit?: number; before?: string } = {},
) {
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canView) throw new ForbiddenError(msg('errors.common.cannotViewCourse'));
  const canPost = await ctx.perm.can('announcement:post', courseId);
  const userId = ctx.perm.userId;
  const myGroups = userId
    ? (
        await ctx.db.groupMember.findMany({
          where: { userId, group: { courseId } },
          select: { groupId: true },
        })
      ).map((g) => g.groupId)
    : [];
  const seen: Prisma.AnnouncementWhereInput[] = [
    canPost ? {} : { publishAt: { lte: ctx.now } },
    canPost ? {} : { OR: [{ groupId: null }, { groupId: { in: myGroups } }] },
  ];
  const limit = opts.limit ?? 30;
  const after = opts.before
    ? await ctx.db.announcement.findFirst({
        where: { id: opts.before, courseId },
        select: { id: true, publishAt: true },
      })
    : null;
  const pinned = after
    ? []
    : await ctx.db.announcement.findMany({
        where: { courseId, pinned: true, AND: seen },
        orderBy: { publishAt: 'desc' },
        include,
      });
  const rest = await ctx.db.announcement.findMany({
    where: {
      courseId,
      pinned: false,
      AND: [
        ...seen,
        after
          ? {
              OR: [
                { publishAt: { lt: after.publishAt } },
                { publishAt: after.publishAt, id: { lt: after.id } },
              ],
            }
          : {},
      ],
    },
    orderBy: [{ publishAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include,
  });
  const page = rest.slice(0, limit);
  return {
    items: [...pinned, ...page],
    canPost,
    next: rest.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function listSiteAnnouncements(db: Db, now = new Date(), limit = 5) {
  return db.announcement.findMany({
    where: { courseId: null, publishAt: { lte: now } },
    orderBy: [{ pinned: 'desc' }, { publishAt: 'desc' }],
    take: limit,
    include,
  });
}

/** The site's announcements, scheduled ones too, a page at a time (the latest first). */
export async function listAllSiteAnnouncements(
  ctx: RequestContext,
  opts: { page?: number; pageSize?: number } = {},
) {
  await ctx.perm.require('site:config', SYSTEM_CONTEXT_ID);
  const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const [total, items] = await Promise.all([
    ctx.db.announcement.count({ where: { courseId: null } }),
    ctx.db.announcement.findMany({
      where: { courseId: null },
      orderBy: [{ publishAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include,
    }),
  ]);
  return { items, total, page, pageSize };
}

/** Latest announcements across the user's courses for the dashboard. */
export async function recentCourseAnnouncements(
  db: Db,
  userId: string,
  courseIds: string[],
  now = new Date(),
  limit = 5,
) {
  if (!courseIds.length) return [];
  const groups = (
    await db.groupMember.findMany({ where: { userId }, select: { groupId: true } })
  ).map((g) => g.groupId);
  return db.announcement.findMany({
    where: {
      courseId: { in: courseIds },
      publishAt: { lte: now, gt: new Date(now.getTime() - 30 * 86_400_000) },
      OR: [{ groupId: null }, { groupId: { in: groups } }],
    },
    orderBy: { publishAt: 'desc' },
    take: limit,
    include: { ...include, course: { select: { id: true, fullName: true } } },
  });
}
