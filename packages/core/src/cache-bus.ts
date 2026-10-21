import type { Db, Prisma } from '@hubium/db';
import { log } from '@hubium/log';
import pg from 'pg';
import { invalidatePermissionCaches } from './access/permissions.ts';
import { sseData } from './lib/sse.ts';
import { isNode, nodeConfig } from './node/config.ts';
import { dispatchRealtime, RT_CHANNEL } from './realtime.ts';
import { invalidateLanguagePacks } from './settings/language-packs.ts';
import { invalidateSettingsCache } from './settings/settings.ts';
import { invalidateWebhookCache } from './webhooks/events.ts';

const logger = log('cache-bus');

// Cross-process cache invalidation over Postgres LISTEN/NOTIFY. Every web and worker
// instance listens on `hubium_cache`; NOTIFY inside a transaction is delivered on commit.
// The same connection listens on `hubium_rt` for realtime events (see realtime.ts).

export type CacheTopic = 'settings' | 'roles' | 'contexts' | 'webhooks' | 'auth' | 'languages';
export const CACHE_CHANNEL = 'hubium_cache';

const subscribers = new Map<string, Set<() => void>>();

/** Runs `fn` whenever any process publishes `topic` (e.g. sign-in providers changed). */
export function onCacheInvalidation(topic: CacheTopic, fn: () => void): () => void {
  let set = subscribers.get(topic);
  if (!set) subscribers.set(topic, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

function applyLocal(topic: string): void {
  if (topic === 'settings') invalidateSettingsCache();
  else if (topic === 'roles') invalidatePermissionCaches('roles');
  else if (topic === 'contexts') invalidatePermissionCaches('contexts');
  else if (topic === 'webhooks') invalidateWebhookCache();
  else if (topic === 'languages') {
    invalidateLanguagePacks();
    // settings name languages: read them again with the new list
    invalidateSettingsCache();
  }
  for (const fn of subscribers.get(topic) ?? []) fn();
}

export async function publishInvalidation(
  db: Db | Prisma.TransactionClient,
  topic: CacheTopic,
): Promise<void> {
  applyLocal(topic);
  await db.$executeRaw`SELECT pg_notify(${CACHE_CHANNEL}, ${topic})`;
}

// The cloud relays every message to its local nodes (node/stream.ts). A bundle may load
// this module more than once, each copy with its own LISTEN client for its own caches; the
// relay takes the messages of one of them, so each reaches the nodes once.
type BusListener = (channel: string, payload: string) => void;
const relay = ((globalThis as { hubiumBusRelay?: Relay }).hubiumBusRelay ??= {
  owner: undefined,
  listeners: new Set<BusListener>(),
});
interface Relay {
  owner: object | undefined;
  listeners: Set<BusListener>;
}

/** Runs `fn` for every message on the bus (cache topics and realtime events). */
export function onBusMessage(fn: BusListener): () => void {
  relay.listeners.add(fn);
  return () => relay.listeners.delete(fn);
}

function relayed(owner: object, channel: string, payload: string): void {
  relay.owner ??= owner;
  if (relay.owner !== owner) return;
  for (const fn of relay.listeners) {
    try {
      fn(channel, payload);
    } catch (err) {
      logger.warn({ err }, 'bus listener failed');
    }
  }
}

/** Applies a message of the bus that arrived another way (a node's stream from the cloud). */
export function applyBusMessage(channel: string, payload: string): void {
  if (channel === CACHE_CHANNEL) applyLocal(payload);
  else if (channel === RT_CHANNEL) dispatchRealtime(payload);
  // the agent of a node lost messages for a while
  else if (channel === 'reset') invalidateAllCaches();
}

/** After a gap in the bus: anything may have changed. */
export function invalidateAllCaches(): void {
  invalidateSettingsCache();
  invalidatePermissionCaches();
  invalidateWebhookCache();
  for (const set of subscribers.values()) for (const fn of set) fn();
}

let listener: pg.Client | undefined;

let streaming = false;

/**
 * On a local node the bus comes from the node's agent as a stream: the node's replica of the
 * database gets no NOTIFY. The agent passes on the cloud's messages once the replica has
 * the changes they announce, and those of the node's own database while it works alone.
 */
function startStreamListener(url: string): void {
  if (streaming) return;
  streaming = true;
  const loop = async () => {
    for (;;) {
      try {
        const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
        if (!res.ok || !res.body) throw new Error(`the agent answered ${res.status}`);
        // whatever happened while the stream was away
        invalidateAllCaches();
        for await (const data of sseData(res.body)) {
          const m = JSON.parse(data) as { c: string; p: string };
          applyBusMessage(m.c, m.p);
        }
      } catch (err) {
        logger.warn({ err }, 'bus stream of the node agent lost; reconnecting');
      }
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  };
  void loop();
}

/** Starts one dedicated LISTEN connection per process; reconnects on failure. */
export async function startCacheListener(
  connectionString = process.env.DATABASE_URL,
): Promise<void> {
  if (isNode()) return startStreamListener(`${nodeConfig().agentUrl}/bus`);
  if (listener || !connectionString) return;
  const client = new pg.Client({ connectionString });
  listener = client;
  client.on('notification', (msg) => {
    if (!msg.payload) return;
    applyBusMessage(msg.channel, msg.payload);
    relayed(client, msg.channel, msg.payload);
  });
  client.on('error', (e) => {
    logger.warn({ err: e }, 'cache bus connection lost; reconnecting');
    listener = undefined;
    if (relay.owner === client) relay.owner = undefined;
    client.end().catch(() => {});
    // Anything may have changed while disconnected.
    invalidateAllCaches();
    setTimeout(() => void startCacheListener(connectionString), 2000);
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CACHE_CHANNEL}`);
    await client.query(`LISTEN ${RT_CHANNEL}`);
  } catch (e) {
    listener = undefined;
    logger.error({ err: e }, 'cache bus could not listen; retrying');
    setTimeout(() => void startCacheListener(connectionString), 5000);
  }
}

export async function stopCacheListener(): Promise<void> {
  const c = listener;
  listener = undefined;
  await c?.end().catch(() => {});
}
