import { withWriteScope } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';
import type { JournalActor } from './journal.ts';
import { execute, JournalOp, replayContext } from './replay.ts';

// Conflicts: entries of a node's journal the cloud did not take (replay.ts). Their authors
// see their own; the teachers of a course those of the course, administrators all. A
// teacher (or an administrator) may accept one: it runs again as its author did it, the
// rules of time and number giving way (a quiz attempt over the limit, work handed in after
// the deadline), and so do the later conflicts of the same person in the same activity
// that it held up (the answers of a refused attempt). Or dismiss it: the work stays here
// to read.

/** Whether the person decides on the conflict: an administrator, or grading the course. */
async function decides(ctx: RequestContext, c: { courseId: string | null }) {
  if (await ctx.perm.can('site:config')) return true;
  return !!c.courseId && (await ctx.perm.can('grade:edit', c.courseId));
}

/** Whether the person may see the conflict: who decides on it, and its author. */
async function sees(ctx: RequestContext, c: { courseId: string | null; actorId: string | null }) {
  if (ctx.actor.kind === 'user' && c.actorId === ctx.actor.userId) return true;
  return decides(ctx, c);
}

export async function getConflict(ctx: RequestContext, id: string) {
  const c = await ctx.db.nodeConflict.findUnique({
    where: { id },
    include: { node: { select: { name: true } } },
  });
  if (!c || !(await sees(ctx, c))) throw new NotFoundError('Conflict');
  const [actor, activity] = await Promise.all([
    c.actorId
      ? ctx.db.user.findUnique({ where: { id: c.actorId }, select: { id: true, name: true } })
      : null,
    c.activityId
      ? ctx.db.activity.findUnique({
          where: { id: c.activityId },
          select: { id: true, name: true, courseId: true, moduleKey: true },
        })
      : null,
  ]);
  return { ...c, actor, activity, canDecide: await decides(ctx, c) };
}

/** Conflicts of a course (teachers), or of the site (administrators), open ones first. */
export async function listConflicts(
  ctx: RequestContext,
  where: { courseId?: string; nodeId?: string; open?: boolean } = {},
) {
  if (where.courseId) await ctx.perm.require('grade:edit', where.courseId);
  else await ctx.perm.require('site:config');
  const rows = await ctx.db.nodeConflict.findMany({
    where: {
      ...(where.courseId ? { courseId: where.courseId } : {}),
      ...(where.nodeId ? { nodeId: where.nodeId } : {}),
      ...(where.open ? { status: 'OPEN' } : {}),
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 500,
    include: { node: { select: { name: true } } },
  });
  const users = await ctx.db.user.findMany({
    where: { id: { in: rows.flatMap((r) => (r.actorId ? [r.actorId] : [])) } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ ...r, actorName: r.actorId ? (names.get(r.actorId) ?? null) : null }));
}

/** The conflicts accepting one takes along: later ones of the same node, person and activity. */
async function chainOf(
  ctx: RequestContext,
  root: { nodeId: string; actorId: string | null; activityId: string | null; op: unknown },
) {
  const seq = BigInt(JournalOp.parse(root.op).seq);
  const open = await ctx.db.nodeConflict.findMany({
    where: {
      nodeId: root.nodeId,
      actorId: root.actorId,
      activityId: root.activityId,
      status: 'OPEN',
    },
  });
  return open
    .map((c) => ({ c, op: JournalOp.parse(c.op) }))
    .filter((x) => BigInt(x.op.seq) >= seq)
    .sort((a, b) => (BigInt(a.op.seq) < BigInt(b.op.seq) ? -1 : 1));
}

export const acceptConflict = defineOperation({
  name: 'node.conflict.accept',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, { id }) {
    const c = await ctx.db.nodeConflict.findUnique({ where: { id } });
    if (!c) throw new NotFoundError('Conflict');
    if (!(await decides(ctx, c))) throw new ForbiddenError(msg('errors.node.cannotDecide'));
  },
  // each entry runs in transactions of its own, as it did on the node
  mutation: false,
  async handler(ctx, { id }) {
    const root = await ctx.db.nodeConflict.findUniqueOrThrow({
      where: { id },
      include: { node: true },
    });
    if (root.status !== 'OPEN') return { accepted: 0 };
    let accepted = 0;
    for (const { c, op } of await chainOf(ctx, root)) {
      try {
        const actorCtx = await replayContext(
          ctx.db,
          root.node,
          op.actor as JournalActor,
          new Date(op.at),
          op.ip,
          true,
        );
        await withWriteScope('node', 'node.conflict.accept', () => execute(ctx.db, actorCtx, op), {
          replay: { ids: op.ids, next: {}, seed: op.seed, uploads: op.uploads },
        });
      } catch (e) {
        // the one the teacher chose must go; the others wait for their own decision
        if (c.id === root.id) throw e;
        continue;
      }
      await withWriteScope('node', 'node.conflict.accept', async () => {
        await ctx.db.nodeConflict.update({
          where: { id: c.id },
          data: { status: 'ACCEPTED', resolvedById: ctx.perm.userId, resolvedAt: ctx.now },
        });
        await ctx.db.nodeOpResult.update({ where: { opId: c.opId }, data: { status: 'APPLIED' } });
      });
      accepted++;
    }
    await withWriteScope('operation', 'node.conflict.accept', async () => {
      await logEvent(ctx.db, {
        name: 'node.conflict.accepted',
        actorId: ctx.perm.userId,
        courseId: root.courseId,
        relatedUserId: root.actorId,
        objectType: 'nodeConflict',
        objectId: root.id,
        data: { accepted },
        origin: ctx.origin,
      });
      if (root.actorId)
        await ctx.db.$transaction((tx) =>
          notifyUsers(tx, [root.actorId!], {
            type: 'node.conflict',
            title: {
              key: 'notifications.text.nodeConflictAccepted',
              values: { node: root.node.name },
            },
            url: `/node-conflicts/${root.id}`,
            courseId: root.courseId ?? undefined,
            actorId: ctx.perm.userId,
          }),
        );
    });
    return { accepted };
  },
});

export const dismissConflict = defineOperation({
  name: 'node.conflict.dismiss',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, { id }) {
    const c = await ctx.db.nodeConflict.findUnique({ where: { id } });
    if (!c) throw new NotFoundError('Conflict');
    if (!(await decides(ctx, c))) throw new ForbiddenError(msg('errors.node.cannotDecide'));
  },
  async handler(ctx, { id }) {
    const c = await ctx.tx.nodeConflict.update({
      where: { id },
      data: { status: 'DISMISSED', resolvedById: ctx.perm.userId, resolvedAt: ctx.now },
    });
    await logEvent(ctx.tx, {
      name: 'node.conflict.dismissed',
      actorId: ctx.perm.userId,
      courseId: c.courseId,
      relatedUserId: c.actorId,
      objectType: 'nodeConflict',
      objectId: c.id,
      origin: ctx.origin,
    });
    return { id };
  },
});
