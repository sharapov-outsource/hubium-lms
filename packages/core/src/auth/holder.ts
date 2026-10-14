import { log } from '@hubium/log';
import { onCacheInvalidation } from '../cache-bus.ts';
import { type Auth, type CreateAuthOptions, createAuth } from './auth.ts';
import { loadCustomOAuth } from './sso.ts';

const logger = log('auth');

// Better Auth's generic OAuth plugin takes its providers when the instance is created, so
// custom OAuth 2 providers from Administration mean a new instance whenever they change.
// The holder keeps the current one and rebuilds it when any process publishes "auth".

export interface AuthHolder {
  /** The instance to use now. */
  current(): Auth;
  /** Settles once the custom providers are loaded (the first instance has none). */
  ready: Promise<void>;
  refresh(): Promise<void>;
}

export function createAuthHolder(opts: Omit<CreateAuthOptions, 'customOAuth'>): AuthHolder {
  let instance = createAuth(opts);
  let generation = 0;
  async function refresh() {
    const mine = ++generation;
    const customOAuth = await loadCustomOAuth(opts.db);
    // a slower, older refresh must not replace a newer instance
    if (mine === generation) instance = createAuth({ ...opts, customOAuth });
  }
  const safe = () =>
    refresh().catch((err) => logger.error({ err }, 'cannot load custom OAuth providers'));
  onCacheInvalidation('auth', () => void safe());
  return { current: () => instance, ready: safe(), refresh };
}

/** An Auth that always forwards to the holder's current instance. */
export function forwardingAuth(holder: AuthHolder): Auth {
  return new Proxy({} as Auth, {
    get: (_, key) => Reflect.get(holder.current(), key),
    has: (_, key) => Reflect.has(holder.current(), key),
  });
}
