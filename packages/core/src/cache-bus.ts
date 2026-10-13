import type { Db, Prisma } from '@hubium/db';
import { log } from '@hubium/log';
import pg from 'pg';
import { invalidatePermissionCaches } from './access/permissions.ts';
import { dispatchRealtime, RT_CHANNEL } from './realtime.ts';
import { invalidateSettingsCache } from './settings/settings.ts';
import { invalidateWebhookCache } from './webhooks/events.ts';

const logger = log('cache-bus');

// Cross-process cache invalidation over Postgres LISTEN/NOTIFY. Every web and worker
// instance listens on `hubium_cache`; NOTIFY inside a transaction is delivered on commit.
// The same connection listens on `hubium_rt` for realtime events (see realtime.ts).

export type CacheTopic = 'settings' | 'roles' | 'contexts' | 'webhooks';
export const CACHE_CHANNEL = 'hubium_cache';

function applyLocal(topic: string): void {
  if (topic === 'settings') invalidateSettingsCache();
  else if (topic === 'roles') invalidatePermissionCaches('roles');
  else if (topic === 'contexts') invalidatePermissionCaches('contexts');
  else if (topic === 'webhooks') invalidateWebhookCache();
}

export async function publishInvalidation(
  db: Db | Prisma.TransactionClient,
  topic: CacheTopic,
): Promise<void> {
  applyLocal(topic);
  await db.$executeRaw`SELECT pg_notify(${CACHE_CHANNEL}, ${topic})`;
}

let listener: pg.Client | undefined;

/** Starts one dedicated LISTEN connection per process; reconnects on failure. */
export async function startCacheListener(
  connectionString = process.env.DATABASE_URL,
): Promise<void> {
  if (listener || !connectionString) return;
  const client = new pg.Client({ connectionString });
  listener = client;
  client.on('notification', (msg) => {
    if (!msg.payload) return;
    if (msg.channel === CACHE_CHANNEL) applyLocal(msg.payload);
    else if (msg.channel === RT_CHANNEL) dispatchRealtime(msg.payload);
  });
  client.on('error', (e) => {
    logger.warn({ err: e }, 'cache bus connection lost; reconnecting');
    listener = undefined;
    client.end().catch(() => {});
    // Anything may have changed while disconnected.
    invalidateSettingsCache();
    invalidatePermissionCaches();
    invalidateWebhookCache();
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
