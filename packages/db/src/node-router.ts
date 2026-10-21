// A local node has two databases: A, its replica of the cloud's, which it reads while it is
// connected, and B, its own copy, which it works on without a connection (docs/PLAN.md). Its
// processes use one client that sends each call to the database of the current mode; the
// node's runtime (packages/core/src/node/runtime.ts) tells which.

export type NodeDatabase = 'a' | 'b';

interface Route {
  a: object;
  b: object;
  pick: () => NodeDatabase;
}

// one map in the process, whichever copy of this module a bundle loaded
const shared = globalThis as unknown as {
  hubiumNodeRoutes?: WeakMap<object, Route>;
  hubiumNodeDatabase?: () => NodeDatabase;
};
const routes = (shared.hubiumNodeRoutes ??= new WeakMap());

/** The database the node uses now: set by the node's runtime; A until then. */
export function currentNodeDatabase(): NodeDatabase {
  return shared.hubiumNodeDatabase?.() ?? 'a';
}

export function setNodeDatabaseSource(fn: () => NodeDatabase): void {
  shared.hubiumNodeDatabase = fn;
}

/**
 * One client over two: each property is the current database's. An extension ($extends)
 * extends both, so a client made from this one (Better Auth's, with its write scope) keeps
 * following the mode.
 */
export function routedClient<T extends object>(
  a: T,
  b: T,
  pick: () => NodeDatabase = currentNodeDatabase,
): T {
  const client = new Proxy(a, {
    get(_target, prop) {
      if (prop === '$extends')
        return (...args: unknown[]) => {
          const ext = (c: T) =>
            (c as unknown as { $extends: (...x: unknown[]) => T }).$extends(...args);
          return routedClient(ext(a), ext(b), pick);
        };
      const c = pick() === 'b' ? b : a;
      const v = Reflect.get(c, prop, c);
      return typeof v === 'function' ? v.bind(c) : v;
    },
  });
  routes.set(client, { a, b, pick });
  return client;
}

/** The two clients behind a routed one; undefined for any other client. */
export function routeOf(client: object): Route | undefined {
  return routes.get(client);
}
