import type { Db, Prisma } from '@hubium/db';
import { uuidv7 } from '@hubium/db';

// Realtime bus: events are published with pg_notify on `hubium_rt` (delivered on commit
// when sent inside a transaction) and dispatched by every web instance to the SSE
// connections of the addressed users. Payloads stay small; clients refetch details.

export const RT_CHANNEL = 'hubium_rt';

export type RealtimeType =
  | 'notification.new'
  | 'notification.read'
  | 'message.new'
  | 'message.read'
  | 'typing'
  | 'task.progress'
  | 'video.status';

export interface RealtimeEvent {
  id: string;
  t: RealtimeType;
  d?: Record<string, unknown>;
}

interface Wire extends RealtimeEvent {
  u: string[];
}

/** NOTIFY payloads are limited to 8000 bytes: ~150 user ids per notification. */
const CHUNK = 150;

export async function publishRealtime(
  db: Db | Prisma.TransactionClient,
  userIds: string[],
  t: RealtimeType,
  d?: Record<string, unknown>,
): Promise<void> {
  const ids = [...new Set(userIds)];
  const id = uuidv7();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const wire: Wire = { id, t, u: ids.slice(i, i + CHUNK), ...(d ? { d } : {}) };
    await db.$executeRaw`SELECT pg_notify(${RT_CHANNEL}, ${JSON.stringify(wire)})`;
  }
}

type Listener = (e: RealtimeEvent) => void;

// Kept on globalThis: bundlers may load this module more than once per process (and each
// copy may run its own LISTEN client), so subscribers are shared and events deduplicated.
const hub: Hub = ((globalThis as { __hubiumRealtime?: Hub }).__hubiumRealtime ??= {
  listeners: new Map<string, Set<Listener>>(),
  seen: new Set<string>(),
  order: [],
});
interface Hub {
  listeners: Map<string, Set<Listener>>;
  seen: Set<string>;
  order: string[];
}
const listeners = hub.listeners;

function firstTime(id: string): boolean {
  if (hub.seen.has(id)) return false;
  hub.seen.add(id);
  hub.order.push(id);
  if (hub.order.length > 2000) hub.seen.delete(hub.order.shift()!);
  return true;
}

/** Subscribes an SSE connection to a user's events. Returns the unsubscribe function. */
export function subscribeRealtime(userId: string, fn: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(userId);
  };
}

export function realtimeConnectionCount(): number {
  let n = 0;
  for (const s of listeners.values()) n += s.size;
  return n;
}

/** Called by the LISTEN client for each `hubium_rt` notification. */
export function dispatchRealtime(payload: string): void {
  let wire: Wire;
  try {
    wire = JSON.parse(payload) as Wire;
  } catch {
    return;
  }
  const { u, ...event } = wire;
  // Chunked events share an id but address different users.
  if (!firstTime(`${event.id}:${u[0]}`)) return;
  for (const userId of u) {
    for (const fn of listeners.get(userId) ?? []) {
      try {
        fn(event);
      } catch (e) {
        console.error('[realtime] listener failed', e);
      }
    }
  }
}
