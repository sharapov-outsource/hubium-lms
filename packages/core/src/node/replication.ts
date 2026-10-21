import { readFileSync } from 'node:fs';
import type { Db, Prisma } from '@hubium/db';

// The cloud's side of a node's copy of the database: each node replicates with a role and a
// physical replication slot of its own (one name for both), members of hubium_nodes. The
// role reads and writes every table, which the node needs on its own copy (B) while it
// works without a connection; the cloud's pg_hba.conf lets it in only for replication
// (docker/node/cloud-hba.conf). Creating roles and slots takes a superuser: the bundled
// database, or one the administrator set up the same way.

type Client = Db | Prisma.TransactionClient;

export const NODE_GROUP = 'hubium_nodes';

/** The role and slot name of a node: lower case letters, digits and _ as both need. */
export function nodeDbRole(nodeId: string): string {
  return `hubium_node_${nodeId.replace(/-/g, '').toLowerCase()}`;
}

const assertName = (name: string) => {
  if (!/^hubium_node_[0-9a-f]{32}$/.test(name)) throw new Error(`Not a node role: ${name}`);
};

/** Statement text with identifiers and literals quoted by the database itself. */
async function formatted(db: Client, template: string, ...args: string[]): Promise<string> {
  const placeholders = args.map((_, i) => `$${i + 1}::text`).join(', ');
  const rows = await db.$queryRawUnsafe<{ sql: string }[]>(
    `SELECT format('${template}', ${placeholders}) AS sql`,
    ...args,
  );
  return rows[0]!.sql;
}

/** hubium_nodes and what its members may do on the copies. */
export async function ensureNodeGroup(db: Client): Promise<void> {
  await db.$executeRawUnsafe(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${NODE_GROUP}') THEN
         CREATE ROLE ${NODE_GROUP} NOLOGIN;
       END IF;
     END $$`,
  );
  await db.$executeRawUnsafe(
    `GRANT pg_read_all_data, pg_write_all_data, pg_monitor TO ${NODE_GROUP}`,
  );
  // the agent promotes the node's own copy (B) when the link is down
  await db.$executeRawUnsafe(
    `GRANT EXECUTE ON FUNCTION pg_promote(boolean, integer) TO ${NODE_GROUP}`,
  );
}

/** Creates the node's role with this password, or gives the existing one the password. */
export async function setNodeRole(db: Client, role: string, password: string): Promise<void> {
  assertName(role);
  const exists = await db.$queryRawUnsafe<unknown[]>(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    role,
  );
  await db.$executeRawUnsafe(
    exists.length
      ? await formatted(db, 'ALTER ROLE %I LOGIN REPLICATION PASSWORD %L', role, password)
      : await formatted(
          db,
          `CREATE ROLE %I LOGIN REPLICATION PASSWORD %L IN ROLE ${NODE_GROUP}`,
          role,
          password,
        ),
  );
}

/** The node's slot, created when missing; it keeps the WAL the node has not received. */
export async function ensureSlot(db: Client, role: string): Promise<void> {
  assertName(role);
  // results of type record and void are not for Prisma to read: executed, not queried
  await db.$executeRawUnsafe(
    `SELECT pg_create_physical_replication_slot($1, true)
       WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $1)`,
    role,
  );
}

/** Ends the node's replication connection, if it has one. */
async function disconnect(db: Client, role: string): Promise<void> {
  await db.$executeRawUnsafe(
    `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots
      WHERE slot_name = $1 AND active_pid IS NOT NULL`,
    role,
  );
}

/**
 * A new slot for a node whose slot was lost (it was away longer than the cloud keeps WAL
 * for, max_slot_wal_keep_size): the node then copies the database again.
 */
export async function resetSlot(db: Client, role: string): Promise<void> {
  assertName(role);
  await disconnect(db, role);
  await db.$executeRawUnsafe(
    `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1`,
    role,
  );
  await ensureSlot(db, role);
}

/** Removes the node's slot and role: it can no longer copy anything. */
export async function dropNodeDb(db: Client, role: string): Promise<void> {
  assertName(role);
  await disconnect(db, role);
  await db.$executeRawUnsafe(
    `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1`,
    role,
  );
  await db.$executeRawUnsafe(await formatted(db, 'DROP ROLE IF EXISTS %I', role));
}

export interface SlotState {
  /** reserved, extended, unreserved (about to be lost) or lost; null: no slot */
  walStatus: string | null;
  active: boolean;
  /** WAL the cloud keeps for the node, in bytes */
  retainedBytes: number | null;
}

export async function slotState(db: Client, role: string): Promise<SlotState> {
  const rows = await db.$queryRawUnsafe<
    { wal_status: string | null; active: boolean; retained: bigint | null }[]
  >(
    `SELECT wal_status, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint AS retained
       FROM pg_replication_slots WHERE slot_name = $1`,
    role,
  );
  const r = rows[0];
  return {
    walStatus: r?.wal_status ?? null,
    active: r?.active ?? false,
    retainedBytes: r?.retained == null ? null : Number(r.retained),
  };
}

/** The cloud's current WAL position: a node's replica has everything up to it once there. */
export async function currentLsn(db: Client): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ lsn: string }[]>(
    'SELECT pg_current_wal_lsn()::text AS lsn',
  );
  return rows[0]!.lsn;
}

/** An LSN ("16/B374D848") as a number, to compare two. */
export function lsnValue(lsn: string): bigint {
  const [hi, lo] = lsn.split('/');
  return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
}

/**
 * Where nodes reach the cloud's database for replication, and the certificate it presents
 * (NODE_REPLICATION_HOST, NODE_REPLICATION_PORT, NODE_REPLICATION_CA or _CA_FILE).
 */
export function replicationEndpoint(env: NodeJS.ProcessEnv = process.env) {
  const ca =
    env.NODE_REPLICATION_CA ||
    (env.NODE_REPLICATION_CA_FILE ? readFileSync(env.NODE_REPLICATION_CA_FILE, 'utf8') : '');
  return {
    host: env.NODE_REPLICATION_HOST || new URL(env.APP_URL || 'http://localhost').hostname,
    port: Number(env.NODE_REPLICATION_PORT) || 5432,
    ca: ca || null,
  };
}
