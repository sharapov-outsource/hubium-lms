import { type Db, freshUuidv7, type OpRecord, type Prisma } from '@hubium/db';
import type { Actor } from '../context.ts';
import { getStorage } from '../files/storage.ts';
import { isNode, releaseId } from './config.ts';
import { nodeState } from './runtime.ts';

// The journal of a local node working without a connection (docs/architecture.md §1.7).
// Every operation, module action, POST to the content origin, side record of a page view
// and sign-in the node does on its own database is written to NodeOp in the transaction of
// the change itself, with what it needs to happen the same way in the cloud: its input,
// who did it and when, the seed of its random numbers, the ids it made (write-scope.ts),
// the rows a guarded one changed as they were, and the files it stored. The sync sends the
// journal; the cloud replays it (replay.ts).

type Tx = Db | Prisma.TransactionClient;

export type JournalKind = 'operation' | 'action' | 'content' | 'touch' | 'auth';

/** Whether this process keeps the journal now: a node working on its own database. */
export function journaling(): boolean {
  return isNode() && nodeState().mode === 'OFFLINE';
}

export type JournalActor =
  | { kind: 'user'; userId: string; realUserId?: string }
  | { kind: 'system' }
  | { kind: 'anonymous' };

export function journalActor(actor: Actor): JournalActor {
  if (actor.kind !== 'user') return { kind: actor.kind };
  return {
    kind: 'user',
    userId: actor.userId,
    ...(actor.realUserId ? { realUserId: actor.realUserId } : {}),
  };
}

export interface JournalEntry {
  kind: JournalKind;
  name: string;
  activityId?: string | null;
  actor: JournalActor;
  input: unknown;
  ip?: string | null;
  at: Date;
  seed: string;
}

/**
 * The input as JSON the replay turns back into the same values: dates tagged, and file
 * contents (a Buffer in a module action's input) stored and named by their storage key,
 * which the sync sends to the cloud before the entry.
 */
export async function toJournalJson(value: unknown, files: Set<string>): Promise<unknown> {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array || value instanceof Blob) {
    const key = `blobs/journal/${freshUuidv7()}`;
    const data =
      value instanceof Blob ? Buffer.from(await value.arrayBuffer()) : Buffer.from(value);
    await getStorage().put(key, data, 'application/octet-stream');
    files.add(key);
    // a File of a form keeps what the operation may read of it
    return value instanceof File
      ? { $file: key, name: value.name, type: value.type }
      : { $blob: key };
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => toJournalJson(v, files)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = await toJournalJson(v, files);
    }
    return out;
  }
  return value;
}

async function stored(key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await getStorage().getStream(key)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** The input of a journal entry as it was given (the replay's side of toJournalJson). */
export async function fromJournalJson(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(fromJournalJson));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.$date === 'string' && Object.keys(o).length === 1) return new Date(o.$date);
    if (typeof o.$blob === 'string' && Object.keys(o).length === 1) return stored(o.$blob);
    if (typeof o.$file === 'string')
      return new File([new Uint8Array(await stored(o.$file))], String(o.name ?? 'file'), {
        type: String(o.type ?? ''),
      });
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = await fromJournalJson(v);
    return out;
  }
  return value;
}

/** Writes an entry with what its operation recorded, in the transaction given. */
export async function writeJournal(db: Tx, e: JournalEntry, record: OpRecord): Promise<void> {
  const input = await toJournalJson(e.input ?? {}, record.files);
  await db.nodeOp.create({
    data: {
      id: freshUuidv7(),
      kind: e.kind,
      name: e.name,
      version: releaseId(),
      activityId: e.activityId ?? null,
      actor: e.actor as object,
      input: input as object,
      ip: e.ip ?? null,
      at: e.at,
      seed: e.seed,
      ids: record.ids,
      guards: (record.guards ?? []) as object,
      files: [...record.files],
      uploads: record.uploads as object,
    },
  });
}
