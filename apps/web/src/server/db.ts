import 'server-only';
import { startCacheListener } from '@hubium/core/cache-bus';
import { startNodeRuntime } from '@hubium/core/node/runtime';
import { getDb } from '@hubium/db';
import '@/modules/server';

export const db = getDb();

// Listen for cross-process cache invalidations in the same module graph that serves
// pages and actions (instrumentation runs in a separate bundle with its own caches).
if (process.env.NEXT_PHASE !== 'phase-production-build') {
  void startCacheListener();
  // on a local node: its mode, and with it the database each request uses
  startNodeRuntime();
}
