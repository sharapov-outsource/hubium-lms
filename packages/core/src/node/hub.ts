import { type Db, type Node, withWriteScope } from '@hubium/db';
import { log } from '@hubium/log';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import { randomToken, sha256Hex } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { AppError, ForbiddenError } from '../errors.ts';
import { touch, touchFromWire } from '../touch/touch.ts';
import { tokenHash } from './auth.ts';
import { releaseId } from './config.ts';
import type { NodeStatus } from './nodes.ts';
import {
  currentLsn,
  ensureNodeGroup,
  ensureSlot,
  replicationEndpoint,
  resetSlot,
  setNodeRole,
  slotState,
} from './replication.ts';

// The cloud's side of the node API (/api/node/*, see api.ts): registration with an
// installation code, heartbeats (and the outages they reveal), the cloud's WAL position for
// reading one's own writes, and the side records of page views the nodes collect.

const logger = log('nodes');

/** A node is heard from every few seconds; a longer silence is an outage. */
export const OUTAGE_GAP_MS = 30_000;
/** Clocks of a node and the cloud may differ this much. */
export const CLOCK_SLACK_MS = 120_000;

/** Node API bookkeeping belongs to the node write scope. */
const nodeScope = <T>(name: string, fn: () => Promise<T>) => withWriteScope('node', name, fn);

export const RegisterInput = z.object({
  code: z.string().min(16).max(200),
  release: z.string().max(200).optional(),
  /** The node's machine (process.arch) and the PostgreSQL releases its replicas come in. */
  arch: z.string().max(40).optional(),
  pgMajors: z.array(z.number().int()).max(20).optional(),
});

/** The machine in PostgreSQL's version() as Node names it. */
const ARCH: Record<string, string> = { x86_64: 'x64', aarch64: 'arm64' };

interface DbFacts {
  v: string;
  build: string;
  provider: string;
  coll: string | null;
}

/** Why a node's replicas cannot copy this database, or null. */
export function replicaMismatch(
  pg: DbFacts,
  node: { arch?: string; pgMajors?: number[] },
): string | null {
  const major = Number(pg.v.split('.')[0]);
  if (node.pgMajors?.length && !node.pgMajors.includes(major))
    return (
      `The cloud's database runs PostgreSQL ${pg.v}; a node's replicas come in ` +
      `${node.pgMajors.join(', ')} (replication needs the same major release)`
    );
  const machine = /\b(x86_64|aarch64)\b/.exec(pg.build)?.[1];
  if (node.arch && machine && ARCH[machine] !== node.arch)
    return (
      `The cloud's database runs on ${machine} and the node is ${node.arch}: a replica copies ` +
      'the database byte for byte and needs the same kind of machine'
    );
  return null;
}

/**
 * Installs a node with its code: a token for the node API, the database role and slot it
 * replicates with, and the secrets it shares with the cloud (APP_SECRET signs sessions,
 * file and content links and seals stored secrets, so the node needs the same).
 */
export async function registerNode(db: Db, raw: unknown) {
  const input = RegisterInput.parse(raw);
  return nodeScope('node.register', async () => {
    const node = await db.node.findUnique({ where: { registrationHash: sha256Hex(input.code) } });
    if (
      !node ||
      node.revokedAt ||
      !node.registrationExpiresAt ||
      node.registrationExpiresAt < new Date()
    )
      throw new ForbiddenError(msg('errors.node.badCode'));
    // what the node's replicas must match: the major release, the machine (the pages are
    // copied byte for byte) and the C library's collations (the text indexes follow them;
    // install-hubium.sh compares them). The code stays valid when they do not.
    const [pg] = await db.$queryRaw<DbFacts[]>`
      SELECT current_setting('server_version') AS v, version() AS build,
             datlocprovider::text AS provider, datcollversion AS coll
        FROM pg_database WHERE datname = current_database()`;
    const mismatch = pg ? replicaMismatch(pg, input) : null;
    if (mismatch) throw new AppError('CONFLICT', mismatch);
    const token = randomToken(32);
    const password = randomToken(24);
    await ensureNodeGroup(db);
    await setNodeRole(db, node.dbRole, password);
    await ensureSlot(db, node.dbRole);
    await db.node.update({
      where: { id: node.id },
      data: {
        tokenHash: tokenHash(token),
        registrationHash: null,
        registrationExpiresAt: null,
        version: input.release ?? null,
      },
    });
    const env = getEnv();
    logger.info({ nodeId: node.id, name: node.name }, 'node registered');
    return {
      nodeId: node.id,
      name: node.name,
      token,
      appSecret: env.APP_SECRET,
      appUrl: env.APP_URL,
      contentHost: env.CONTENT_HOST ?? null,
      release: releaseId(),
      database: {
        ...replicationEndpoint(),
        role: node.dbRole,
        password,
        slot: node.dbRole,
        name: new URL(env.DATABASE_URL).pathname.slice(1) || 'hubium',
        serverVersion: pg?.v ?? null,
        serverBuild: pg?.build ?? null,
        collation: pg ? { provider: pg.provider, version: pg.coll } : null,
      },
    };
  });
}

export const HeartbeatInput = z.object({
  mode: z.enum(['ONLINE', 'READONLY', 'OFFLINE', 'SYNC', 'PASSTHROUGH']),
  release: z.string().max(200),
  status: z.record(z.string(), z.unknown()).default({}),
});

/**
 * A node's heartbeat. A silence longer than OUTAGE_GAP_MS since the last one, or a node
 * working on its own (OFFLINE) while the cloud still hears it (the administrator turned
 * the mode on), opens an outage; the node back ONLINE after its sync closes it.
 */
export async function heartbeat(db: Db, node: Node, raw: unknown) {
  const input = HeartbeatInput.parse(raw);
  const now = new Date();
  return nodeScope('node.heartbeat', async () => {
    const open = await db.nodeOutage.findFirst({
      where: { nodeId: node.id, syncedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    const silent = node.lastSeenAt && now.getTime() - node.lastSeenAt.getTime() > OUTAGE_GAP_MS;
    if (!open && (silent || input.mode === 'OFFLINE')) {
      await db.nodeOutage.create({
        data: {
          nodeId: node.id,
          startedAt: silent ? node.lastSeenAt! : now,
          endedAt: input.mode === 'OFFLINE' ? null : now,
        },
      });
    } else if (open && !open.endedAt && input.mode !== 'OFFLINE') {
      // heard again: the gap is over, its sync is to come
      await db.nodeOutage.update({ where: { id: open.id }, data: { endedAt: now } });
    }
    if (open && input.mode === 'ONLINE' && open.endedAt)
      await db.nodeOutage.update({ where: { id: open.id }, data: { syncedAt: now } });
    const slot = await slotState(db, node.dbRole);
    const status: NodeStatus = { ...(input.status as NodeStatus), slot: slot.walStatus };
    await db.node.update({
      where: { id: node.id },
      data: {
        mode: input.mode,
        version: input.release,
        status: status as object,
        lastSeenAt: now,
        // done with its journal: the next node's turn
        ...(input.mode === 'SYNC' ? {} : { replayingAt: null }),
      },
    });
    return {
      now: now.toISOString(),
      release: releaseId(),
      categoryIds: node.categoryIds,
      slot,
      lsn: await currentLsn(db),
    };
  });
}

/** The node's slot again after it was lost: the node then copies the database anew. */
export async function renewSlot(db: Db, node: Node) {
  await resetSlot(db, node.dbRole);
  logger.warn({ nodeId: node.id }, 'replication slot of a node created anew');
  return { ok: true };
}

/** A side record as it travels from a node: its dates as strings. */
const TouchWire = z.object({
  at: z.string().datetime({ offset: true }),
  touch: z.record(z.string(), z.unknown()).and(z.object({ kind: z.string() })),
});

/** Side records of page views on a node, recorded in the cloud as they happened. */
export async function receiveTouches(db: Db, node: Node, raw: unknown) {
  const items = z.array(TouchWire).max(1000).parse(raw);
  const now = Date.now();
  let recorded = 0;
  for (const w of items) {
    // never in the future, whatever the node's clock says
    const at = new Date(Math.min(Date.parse(w.at), now));
    try {
      await touch(db, touchFromWire(w), at);
      recorded++;
    } catch (err) {
      // a record about something deleted meanwhile: nothing to keep
      logger.debug({ err, nodeId: node.id, kind: w.touch.kind }, 'side record of a node dropped');
    }
  }
  return { recorded };
}
