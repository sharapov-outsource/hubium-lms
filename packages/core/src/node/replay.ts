import { type Db, type Node, type Prisma, rowHash, withWriteScope } from '@hubium/db';
import { log } from '@hubium/log';
import { z } from 'zod';
import { anonymousAccess, loadUserAccess, Permissions } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';
import { AppError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { runModuleAction } from '../modules/actions.ts';
import { type ContentInput, runContent } from '../modules/content-run.ts';
import { getModule } from '../modules/registry.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { getOperation } from '../operation.ts';
import { getAllSettings, userLocale } from '../settings/settings.ts';
import { touch, touchFromWire } from '../touch/touch.ts';
import { CLOCK_SLACK_MS } from './hub.ts';
import { fromJournalJson, type JournalActor } from './journal.ts';
import { currentLsn } from './replication.ts';

// The cloud's replay of a node's journal (docs/architecture.md §1.7). One node at a time,
// entries in order, each once (by its id): an entry runs as the operation it records, as
// the person who did it, at the time they did it (inside the node's outage), with the
// node's random numbers and the ids the node gave its rows, so links people saw keep
// working. The cloud's rules decide again: a guarded entry whose rows changed in the
// cloud meanwhile, or one a rule refuses now, becomes a conflict, its author is told, and
// the work it carries is kept for a teacher to accept.

const logger = log('node-replay');

export const JournalOp = z.object({
  id: z.string().uuid(),
  seq: z.string(),
  kind: z.enum(['operation', 'action', 'content', 'touch', 'auth']),
  name: z.string().max(200),
  version: z.string().max(200),
  activityId: z.string().uuid().nullable(),
  actor: z.record(z.string(), z.unknown()),
  input: z.unknown(),
  ip: z.string().nullable(),
  at: z.string().datetime({ offset: true }),
  seed: z.string(),
  ids: z.record(z.string(), z.array(z.string().uuid())).default({}),
  guards: z
    .array(
      z.object({
        model: z.string(),
        where: z.record(z.string(), z.unknown()),
        hash: z.string().nullable(),
      }),
    )
    .default([]),
  files: z.array(z.string()).default([]),
  uploads: z
    .record(
      z.string(),
      z.object({ key: z.string(), name: z.string(), mimeType: z.string(), size: z.number() }),
    )
    .default({}),
});
export type JournalOp = z.infer<typeof JournalOp>;

const ReplayInput = z.object({ ops: z.array(JournalOp).max(500) });

export interface ReplayResult {
  id: string;
  status: 'APPLIED' | 'CONFLICT' | 'REJECTED';
  error?: string;
  /** Taken before: the node sent the batch again (its answer was lost). */
  repeated?: boolean;
}

/** A journal entry the cloud does not take, and why (a message key and its values). */
class Refused extends Error {
  readonly reason: { key: string; values?: Record<string, unknown>; rows?: unknown };
  constructor(key: string, values?: Record<string, unknown>, rows?: unknown) {
    super(key);
    this.reason = { key, ...(values ? { values } : {}), ...(rows ? { rows } : {}) };
  }
}

/** A node's turn lasts while its batches keep coming. */
const TURN_MS = 60_000;

/**
 * Takes the replay's turn for the node: false while another node's journal is being
 * replayed (its last batch less than TURN_MS ago).
 */
async function takeTurn(db: Db, node: Node): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hubium.node.replay'))`;
    const busy = await tx.node.findFirst({
      where: {
        id: { not: node.id },
        revokedAt: null,
        replayingAt: { gt: new Date(Date.now() - TURN_MS) },
      },
      select: { id: true },
    });
    if (busy) return false;
    await tx.node.update({ where: { id: node.id }, data: { replayingAt: new Date() } });
    return true;
  });
}

/** Replays a batch of a node's journal; 'busy' while another node has the turn. */
export async function replayBatch(
  db: Db,
  node: Node,
  raw: unknown,
): Promise<{ results: ReplayResult[]; lsn: string } | 'busy'> {
  const { ops } = ReplayInput.parse(raw);
  return withWriteScope('node', 'node.replay', async () => {
    if (!(await takeTurn(db, node))) return 'busy' as const;
    const results: ReplayResult[] = [];
    for (const op of ops) results.push(await replayOne(db, node, op));
    const fresh = results.filter((r) => !r.repeated);
    const applied = fresh.filter((r) => r.status === 'APPLIED').length;
    const conflicts = fresh.filter((r) => r.status === 'CONFLICT').length;
    const outage = await db.nodeOutage.findFirst({
      where: { nodeId: node.id, syncedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (outage && fresh.length)
      await db.nodeOutage.update({
        where: { id: outage.id },
        data: { applied: { increment: applied }, conflicts: { increment: conflicts } },
      });
    return { results, lsn: await currentLsn(db) };
  });
}

/** Whether the entry's time lies within an outage of the node the cloud knows of. */
async function inOutage(db: Db, node: Node, at: Date): Promise<boolean> {
  const outages = await db.nodeOutage.findMany({
    where: { nodeId: node.id, startedAt: { lte: new Date(at.getTime() + CLOCK_SLACK_MS) } },
    orderBy: { startedAt: 'desc' },
    take: 5,
  });
  return outages.some(
    (o) =>
      at.getTime() >= o.startedAt.getTime() - CLOCK_SLACK_MS &&
      at.getTime() <= (o.endedAt ?? new Date()).getTime() + CLOCK_SLACK_MS,
  );
}

/** The request context of the person the entry names, as they were then. */
export async function replayContext(
  db: Db,
  node: Node,
  actor: JournalActor,
  at: Date,
  ip: string | null,
  override = false,
): Promise<RequestContext> {
  const settings = await getAllSettings(db);
  const base = { db, now: at, ip, origin: 'WEB' as const, nodeId: node.id, override };
  if (actor.kind === 'system')
    return {
      ...base,
      actor: { kind: 'system' },
      perm: new Permissions(db, { kind: 'system' }),
      locale: userLocale(settings, null),
    };
  if (actor.kind === 'anonymous')
    return {
      ...base,
      actor: { kind: 'anonymous' },
      perm: new Permissions(db, await anonymousAccess(db)),
      locale: userLocale(settings, null),
    };
  const user = await db.user.findUnique({ where: { id: actor.userId } });
  if (!user || user.deletedAt || user.status !== 'ACTIVE')
    throw new Refused('nodes.reason.actorGone');
  return {
    ...base,
    actor: {
      kind: 'user',
      userId: user.id,
      isSiteAdmin: user.isSiteAdmin,
      ...(actor.realUserId ? { realUserId: actor.realUserId } : {}),
    },
    perm: new Permissions(db, await loadUserAccess(db, user, { now: at })),
    locale: userLocale(settings, user.locale),
  };
}

const delegate = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/** The rows a guarded entry changed that the cloud changed too since the node had them. */
async function changedRows(db: Db, op: JournalOp) {
  const differ: { model: string; where: Record<string, unknown> }[] = [];
  for (const g of op.guards) {
    const d = (db as unknown as Record<string, { findFirst(a: unknown): Promise<unknown> }>)[
      delegate(g.model)
    ];
    if (!d) continue;
    const row = await d.findFirst({ where: g.where });
    if (rowHash(row) !== g.hash) differ.push({ model: g.model, where: g.where });
  }
  return differ;
}

/** Runs the entry as what it records (in the cloud's replay scope). */
export async function execute(db: Db, ctx: RequestContext, op: JournalOp): Promise<void> {
  const input = await fromJournalJson(op.input);
  switch (op.kind) {
    case 'operation': {
      const def = getOperation(op.name);
      if (!def) throw new Refused('nodes.reason.unknown', { name: op.name });
      await def.run(ctx, input);
      return;
    }
    case 'action': {
      if (!op.activityId) throw new Refused('nodes.reason.unknown', { name: op.name });
      const action = op.name.slice(op.name.indexOf('.') + 1);
      await runModuleAction(ctx, op.activityId, action, input);
      return;
    }
    case 'content': {
      const m = getModule(op.name.replace(/\.content$/, ''));
      const c = input as ContentInput;
      if (!m?.content || !op.activityId)
        throw new Refused('nodes.reason.unknown', { name: op.name });
      const actor = op.actor as { userId?: string };
      const req = new Request(c.url, {
        method: c.method,
        headers: c.contentType ? { 'content-type': c.contentType } : {},
        body: c.body,
      });
      const res = await runContent(
        { ...ctx, actor: { kind: 'system' }, perm: new Permissions(db, { kind: 'system' }) },
        m,
        { activityId: op.activityId, userId: actor.userId ?? '', data: c.data, token: '' },
        req,
        c.path,
        op.seed,
      );
      if (!res.ok) throw new Refused('nodes.reason.refused', { status: res.status });
      return;
    }
    case 'touch':
      await touch(db, touchFromWire(input as { touch: Record<string, unknown> }), new Date(op.at));
      return;
    case 'auth':
      await replayAuth(db, op, input as Record<string, unknown>);
      return;
  }
}

/** A sign-in on the node: the same session (its token keeps the person signed in), or its end. */
async function replayAuth(db: Db, op: JournalOp, input: Record<string, unknown>) {
  await withWriteScope('auth', op.name, async () => {
    if (op.name === 'session.delete') {
      await db.session.deleteMany({ where: { token: String(input.token) } });
      return;
    }
    if (op.name !== 'session.create') throw new Refused('nodes.reason.unknown', { name: op.name });
    const s = input as Prisma.SessionUncheckedCreateInput;
    await db.session.createMany({
      data: [
        {
          id: s.id,
          token: s.token,
          userId: s.userId,
          expiresAt: s.expiresAt,
          ipAddress: s.ipAddress ?? null,
          userAgent: s.userAgent ?? null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        },
      ],
      skipDuplicates: true,
    });
    await logEvent(db, {
      name: 'user.loggedin',
      actorId: s.userId,
      relatedUserId: s.userId,
      ip: (s.ipAddress as string | null) ?? null,
      realActorId: null,
    });
  });
}

/** The course of an entry, for the teachers who see its conflict. */
async function courseOf(db: Db, op: JournalOp, input: unknown): Promise<string | null> {
  if (op.activityId) {
    const a = await db.activity.findUnique({
      where: { id: op.activityId },
      select: { courseId: true },
    });
    if (a) return a.courseId;
  }
  const id = (input as { courseId?: unknown } | null)?.courseId;
  return typeof id === 'string' ? id : null;
}

async function replayOne(db: Db, node: Node, op: JournalOp): Promise<ReplayResult> {
  const done = await db.nodeOpResult.findUnique({ where: { opId: op.id } });
  if (done)
    return {
      id: op.id,
      status: done.status as ReplayResult['status'],
      error: done.error ?? undefined,
      repeated: true,
    };
  const at = new Date(op.at);
  const actor = op.actor as JournalActor;
  const result = (status: 'APPLIED' | 'CONFLICT') => (tx: Prisma.TransactionClient) =>
    tx.nodeOpResult.create({ data: { opId: op.id, nodeId: node.id, status } }).then(() => {});
  try {
    if (!(await inOutage(db, node, at))) throw new Refused('nodes.reason.time');
    const ctx = await replayContext(db, node, actor, at, op.ip);
    const differ = await changedRows(db, op);
    if (differ.length) throw new Refused('nodes.reason.changed', undefined, differ);
    await withWriteScope('node', 'node.replay', () => execute(db, ctx, op), {
      replay: {
        ids: op.ids,
        next: {},
        seed: op.seed,
        uploads: op.uploads,
        commit: result('APPLIED'),
      },
    });
    // entries without a transaction of their own (sign-ins, side records, content) and
    // those whose operation recorded no result: recorded now
    await db.nodeOpResult.createMany({
      data: [{ opId: op.id, nodeId: node.id, status: 'APPLIED' }],
      skipDuplicates: true,
    });
    return { id: op.id, status: 'APPLIED' };
  } catch (e) {
    const reason =
      e instanceof Refused
        ? e.reason
        : e instanceof AppError
          ? { key: e.msg?.key ?? 'nodes.reason.refused', values: e.msg?.values, message: e.message }
          : { key: 'nodes.reason.failed', message: e instanceof Error ? e.message : String(e) };
    if (!(e instanceof Refused) && !(e instanceof AppError))
      logger.error({ err: e, opId: op.id, name: op.name }, 'journal entry failed in the cloud');
    if (sideEntry(op)) {
      // what the person saw (posts read): dropped, not kept as a conflict
      await db.nodeOpResult.createMany({
        data: [{ opId: op.id, nodeId: node.id, status: 'REJECTED', error: reason.key }],
        skipDuplicates: true,
      });
      logger.debug({ opId: op.id, name: op.name, reason: reason.key }, 'side entry dropped');
      return { id: op.id, status: 'REJECTED', error: reason.key };
    }
    await conflict(db, node, op, reason);
    return { id: op.id, status: 'CONFLICT', error: reason.key };
  }
}

/** An entry whose policy is `side`: a record of what a person saw, dropped when refused. */
function sideEntry(op: JournalOp): boolean {
  if (op.kind === 'operation') return getOperation(op.name)?.offline === 'side';
  if (op.kind !== 'action') return false;
  const dot = op.name.indexOf('.');
  return getModule(op.name.slice(0, dot))?.actions?.[op.name.slice(dot + 1)]?.offline === 'side';
}

/** Keeps a refused entry as a conflict and tells its author (and the site admins). */
async function conflict(db: Db, node: Node, op: JournalOp, reason: object) {
  const input = op.input;
  const actorId = (op.actor as { userId?: string }).userId ?? null;
  const courseId = await courseOf(db, op, input).catch(() => null);
  await db.$transaction(async (tx) => {
    const c = await tx.nodeConflict.upsert({
      where: { opId: op.id },
      create: {
        nodeId: node.id,
        opId: op.id,
        kind: op.kind,
        name: op.name,
        actorId,
        courseId,
        activityId: op.activityId,
        op: op as object,
        reason,
      },
      update: { reason },
    });
    await tx.nodeOpResult.create({ data: { opId: op.id, nodeId: node.id, status: 'CONFLICT' } });
    // side records and sign-ins are nobody's work: no word about them
    if (actorId && (op.kind === 'operation' || op.kind === 'action' || op.kind === 'content'))
      await notifyUsers(tx, [actorId], {
        type: 'node.conflict',
        title: { key: 'notifications.text.nodeConflict', values: { node: node.name } },
        url: `/node-conflicts/${c.id}`,
        courseId: courseId ?? undefined,
      });
  });
}

/**
 * Results of journal entries a node can no longer send again: those before its last
 * finished sync, after which its own copy was made anew. They answered batches sent twice;
 * removed by the daily housekeeping.
 */
export async function pruneReplayResults(db: Db): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "NodeOpResult" r
     WHERE r."createdAt" < (SELECT max(o."syncedAt") FROM "NodeOutage" o WHERE o."nodeId" = r."nodeId")
                           - interval '1 day'`;
}
