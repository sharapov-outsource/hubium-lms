import type { Prisma } from '@hubium/db';
import type { RequestContext } from '../context.ts';

export interface CourseLogFilter {
  /** Part of the name or email of who did it. */
  who?: string;
  /** An event name, e.g. `activity.viewed`. */
  name?: string;
  activityId?: string;
  from?: Date;
  /** Up to, not including. */
  to?: Date;
  /** The id of the last event of the page before (see `next`). */
  before?: string;
  limit?: number;
}

/**
 * A course's event log, the latest first, filtered by who, what, which activity and when,
 * a page at a time: `next` continues it. Pages go by a cursor rather than a count, which
 * a log of millions of events would make slow.
 */
export async function courseEventLog(
  ctx: RequestContext,
  courseId: string,
  f: CourseLogFilter = {},
) {
  await ctx.perm.require('report:logs', courseId);
  const limit = Math.min(200, Math.max(1, Math.floor(f.limit ?? 50)));
  const who = f.who?.trim();
  const actors = who
    ? (
        await ctx.db.user.findMany({
          where: {
            OR: [
              { name: { contains: who, mode: 'insensitive' } },
              { email: { contains: who, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
          take: 500,
        })
      ).map((u) => u.id)
    : null;
  const before =
    f.before && /^\d{1,19}$/.test(f.before)
      ? await ctx.db.eventLog.findFirst({
          where: { id: BigInt(f.before), courseId },
          select: { id: true, createdAt: true },
        })
      : null;
  const where: Prisma.EventLogWhereInput = {
    courseId,
    ...(actors ? { actorId: { in: actors } } : {}),
    ...(f.name ? { name: f.name } : {}),
    ...(f.activityId ? { contextId: f.activityId } : {}),
    AND: [
      f.from || f.to
        ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } }
        : {},
      before
        ? {
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          }
        : {},
    ],
  };
  const rows = await ctx.db.eventLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const items = rows.slice(0, limit);
  const names = new Map(
    (
      await ctx.db.user.findMany({
        where: { id: { in: [...new Set(items.flatMap((l) => (l.actorId ? [l.actorId] : [])))] } },
        select: { id: true, name: true },
      })
    ).map((u) => [u.id, u.name]),
  );
  return {
    items: items.map((l) => ({
      id: String(l.id),
      name: l.name,
      createdAt: l.createdAt,
      contextId: l.contextId,
      actor: l.actorId ? (names.get(l.actorId) ?? null) : null,
    })),
    next: rows.length > limit ? String(items.at(-1)!.id) : null,
  };
}
