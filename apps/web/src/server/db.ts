import 'server-only';
import { startCacheListener } from '@hubium/core/cache-bus';
import { CLIENT_IP_HEADER } from '@hubium/core/client-ip';
import { setTouchAddress, startNodeRuntime } from '@hubium/core/node/runtime';
import { getDb } from '@hubium/db';
import { headers } from 'next/headers';
import '@/modules/server';

export const db = getDb();

// Listen for cross-process cache invalidations in the same module graph that serves
// pages and actions (instrumentation runs in a separate bundle with its own caches).
if (process.env.NEXT_PHASE !== 'phase-production-build') {
  void startCacheListener();
  // on a local node: its mode, and with it the database each request uses
  startNodeRuntime();
  // the address a page view's side record comes from, which the agent waits on
  setTouchAddress(async () => (await headers()).get(CLIENT_IP_HEADER));
}
