import { uuidv7 } from '@hubium/db';
import { log } from '@hubium/log';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { NotFoundError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { defineOperation } from '../operation.ts';
import { dropNodeDb, nodeDbRole } from './replication.ts';

// The cloud's register of local nodes (Administration → Nodes): a node is added with a
// name, which gives an installation code; `install-hubium.sh --node` registers the server
// with that code (hub.ts). Revoking a node takes its token, its database role and its slot.

const logger = log('nodes');

/** How long an installation code works. */
export const REGISTRATION_HOURS = 24;

const requireAdmin = (ctx: RequestContext) => ctx.perm.require('site:config');

const NodeFields = z.object({
  name: z.string().trim().min(1).max(200),
  /** Files of courses in these categories and below go to the node; none: all files. */
  categoryIds: z.array(z.string().uuid()).max(500).default([]),
});

function newCode(now: Date) {
  const code = randomToken(24);
  return {
    code,
    data: {
      registrationHash: sha256Hex(code),
      registrationExpiresAt: new Date(now.getTime() + REGISTRATION_HOURS * 3_600_000),
    },
  };
}

export const createNode = defineOperation({
  name: 'node.create',
  offline: 'online',
  input: NodeFields,
  authorize: requireAdmin,
  async handler(ctx, input) {
    const id = uuidv7(ctx.now.getTime());
    const { code, data } = newCode(ctx.now);
    await ctx.tx.node.create({
      data: {
        id,
        name: input.name,
        categoryIds: input.categoryIds,
        dbRole: nodeDbRole(id),
        ...data,
      },
    });
    await logEvent(ctx.tx, {
      name: 'node.created',
      actorId: ctx.perm.userId,
      objectType: 'node',
      objectId: id,
      data: { name: input.name },
      origin: ctx.origin,
    });
    return { id, code };
  },
});

/** A new installation code, to install the node again (another server, a fresh disk). */
export const newNodeCode = defineOperation({
  name: 'node.code',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id }) {
    const node = await ctx.tx.node.findUnique({ where: { id } });
    if (!node || node.revokedAt) throw new NotFoundError('Node');
    const { code, data } = newCode(ctx.now);
    await ctx.tx.node.update({ where: { id }, data });
    await logEvent(ctx.tx, {
      name: 'node.code',
      actorId: ctx.perm.userId,
      objectType: 'node',
      objectId: id,
      origin: ctx.origin,
    });
    return { code };
  },
});

export const updateNode = defineOperation({
  name: 'node.update',
  offline: 'online',
  input: NodeFields.extend({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id, ...input }) {
    const node = await ctx.tx.node.findUnique({ where: { id } });
    if (!node || node.revokedAt) throw new NotFoundError('Node');
    await ctx.tx.node.update({ where: { id }, data: input });
    await logEvent(ctx.tx, {
      name: 'node.updated',
      actorId: ctx.perm.userId,
      objectType: 'node',
      objectId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

/** Makes someone one of the people who look after the node (its state, its modes), or not. */
export const setNodeAdmin = defineOperation({
  name: 'node.admin',
  offline: 'online',
  input: z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    admin: z.boolean(),
  }),
  authorize: requireAdmin,
  async handler(ctx, { id, userId, admin }) {
    const node = await ctx.tx.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundError('Node');
    if (admin) {
      const user = await ctx.tx.user.findUnique({ where: { id: userId } });
      if (!user || user.deletedAt) throw new NotFoundError('User');
      await ctx.tx.nodeAdmin.upsert({
        where: { nodeId_userId: { nodeId: id, userId } },
        create: { nodeId: id, userId },
        update: {},
      });
    } else await ctx.tx.nodeAdmin.deleteMany({ where: { nodeId: id, userId } });
    await logEvent(ctx.tx, {
      name: admin ? 'node.admin.added' : 'node.admin.removed',
      actorId: ctx.perm.userId,
      relatedUserId: userId,
      objectType: 'node',
      objectId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

/**
 * Revokes the node: its token stops working and its database role and slot go, so it gets
 * nothing more from the cloud. What it holds stays on its disk: wipe that server.
 */
export const revokeNode = defineOperation({
  name: 'node.revoke',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id }) {
    const node = await ctx.tx.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundError('Node');
    await ctx.tx.node.update({
      where: { id },
      data: { revokedAt: ctx.now, tokenHash: null, registrationHash: null },
    });
    await logEvent(ctx.tx, {
      name: 'node.revoked',
      actorId: ctx.perm.userId,
      objectType: 'node',
      objectId: id,
      origin: ctx.origin,
    });
    // the role and the slot are not part of the transaction
    ctx.afterCommit(() =>
      dropNodeDb(ctx.db, node.dbRole).catch((err) =>
        logger.error({ err, nodeId: id }, 'could not drop the database role of a revoked node'),
      ),
    );
    return { id };
  },
});

/** Removes a revoked node from the list, with its outages and conflicts. */
export const deleteNode = defineOperation({
  name: 'node.delete',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id }) {
    const node = await ctx.tx.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundError('Node');
    if (!node.revokedAt) throw new NotFoundError('Node');
    await ctx.tx.node.delete({ where: { id } });
    await logEvent(ctx.tx, {
      name: 'node.deleted',
      actorId: ctx.perm.userId,
      objectType: 'node',
      objectId: id,
      data: { name: node.name },
      origin: ctx.origin,
    });
    return { id };
  },
});

/** Whether the person looks after this node: a site administrator, or one of its admins. */
export async function isNodeAdmin(ctx: RequestContext, nodeId: string): Promise<boolean> {
  if (await ctx.perm.can('site:config')) return true;
  if (ctx.actor.kind !== 'user') return false;
  return !!(await ctx.db.nodeAdmin.findUnique({
    where: { nodeId_userId: { nodeId, userId: ctx.actor.userId } },
  }));
}

/** Every node, for the administrators' list. */
export async function listNodes(ctx: RequestContext) {
  await requireAdmin(ctx);
  const nodes = await ctx.db.node.findMany({ orderBy: { createdAt: 'asc' } });
  const conflicts = await ctx.db.nodeConflict.groupBy({
    by: ['nodeId'],
    where: { status: 'OPEN' },
    _count: true,
  });
  const open = new Map(conflicts.map((c) => [c.nodeId, c._count]));
  return nodes.map((n) => ({ ...nodeView(n), openConflicts: open.get(n.id) ?? 0 }));
}

/** A node with its admins and its latest outages, for its page. */
export async function getNode(ctx: RequestContext, id: string) {
  if (!(await isNodeAdmin(ctx, id))) await requireAdmin(ctx);
  const node = await ctx.db.node.findUnique({
    where: { id },
    include: {
      admins: { include: { user: { select: { id: true, name: true, email: true } } } },
      outages: { orderBy: { startedAt: 'desc' }, take: 20 },
    },
  });
  if (!node) throw new NotFoundError('Node');
  const openConflicts = await ctx.db.nodeConflict.count({ where: { nodeId: id, status: 'OPEN' } });
  return {
    ...nodeView(node),
    admins: node.admins.map((a) => a.user),
    outages: node.outages,
    openConflicts,
  };
}

/** A node as people see it: never its hashes. */
export function nodeView(n: {
  id: string;
  name: string;
  categoryIds: string[];
  mode: string;
  version: string | null;
  status: unknown;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  tokenHash: string | null;
  registrationExpiresAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    name: n.name,
    categoryIds: n.categoryIds,
    mode: n.mode,
    version: n.version,
    status: (n.status ?? {}) as NodeStatus,
    lastSeenAt: n.lastSeenAt,
    revokedAt: n.revokedAt,
    installed: !!n.tokenHash,
    codeExpiresAt: n.tokenHash ? null : n.registrationExpiresAt,
    createdAt: n.createdAt,
  };
}

/** What a node reports in its heartbeat besides its mode (hub.ts). */
export interface NodeStatus {
  /** How far its replica (A) is behind the cloud, in bytes of WAL. */
  lagBytes?: number | null;
  /** Its own copy (B): ready, being copied, or in use without a connection. */
  replicaB?: 'ready' | 'copying' | 'promoted' | 'missing';
  /** Files: copied and in all. */
  files?: { done: number; total: number; bytes: number };
  /** Journal entries not yet taken by the cloud. */
  pendingOps?: number;
  /** Since when it has had no connection, as it saw it. */
  offlineSince?: string | null;
  /** The administrator put the sync off until this time. */
  syncPostponedUntil?: string | null;
  /** The cloud's slot for it: lost means a new copy of the database. */
  slot?: string | null;
  error?: string | null;
}
