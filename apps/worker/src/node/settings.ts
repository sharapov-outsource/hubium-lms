import { nodeConfig, releaseId } from '@hubium/core/node/config';

// What the agent of a local node needs: the node's settings (installer-written, see
// packages/core/src/node/config.ts) and where things are on the node.

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function agentSettings(env: NodeJS.ProcessEnv = process.env) {
  const node = nodeConfig(env);
  const hub = new URL(node.hubUrl);
  const hubContent = env.NODE_HUB_CONTENT_HOST ? new URL(env.NODE_HUB_CONTENT_HOST) : null;
  return {
    node,
    release: releaseId(),
    /** The gateway: what the people of the node's network reach (behind its Caddy). */
    gatewayPort: num(env.NODE_GATEWAY_PORT, 3000),
    gatewayHost: env.NODE_GATEWAY_HOST || '0.0.0.0',
    /** The agent's own API for the node's web server (state, side records, bus). */
    controlPort: num(env.NODE_CONTROL_PORT, 3002),
    controlHost: env.NODE_CONTROL_HOST || '0.0.0.0',
    /** The node's web server. */
    webUrl: new URL(env.NODE_WEB_URL || 'http://127.0.0.1:3001'),
    /** The cloud's addresses (NODE_HUB_URL, NODE_HUB_CONTENT_HOST). */
    cloud: { app: hub, content: hubContent },
    /**
     * The node's addresses (APP_URL, CONTENT_HOST): the cloud's, as the network's DNS sends
     * them here, or others (a pilot before the DNS change); requests then go to the cloud
     * under its names and its redirects come back under the node's.
     */
    public: {
      app: env.APP_URL ? new URL(env.APP_URL) : hub,
      content: env.CONTENT_HOST ? new URL(env.CONTENT_HOST) : hubContent,
    },
    /** Replica A (DATABASE_URL) and the node's own copy B. */
    databaseA: env.DATABASE_URL ?? '',
    databaseB: node.databaseBUrl ?? '',
    /** Directories the replicas' containers watch for a request of a new copy. */
    controlA: env.NODE_REPLICA_A_CONTROL || '/control/a',
    controlB: env.NODE_REPLICA_B_CONTROL || '/control/b',
    /** How long without the cloud before the node works on its own (seconds). */
    offlineAfterMs: num(env.NODE_OFFLINE_AFTER, 120) * 1000,
    /** How long a reading request waits for the replica to have the person's last change. */
    lsnWaitMs: num(env.NODE_LSN_WAIT_MS, 3000),
    heartbeatMs: num(env.NODE_HEARTBEAT_MS, 5000),
    /**
     * The cloud's certificates for the node's Caddy (NODE_TLS=cloud): where they are kept,
     * and how Caddy is told to load them.
     */
    tlsDir: (env.NODE_TLS || 'cloud') === 'cloud' ? env.NODE_TLS_DIR || '' : '',
    caddyAdmin: (env.NODE_CADDY_ADMIN || 'http://caddy:2019').replace(/\/+$/, ''),
    caddyfile: env.NODE_CADDYFILE || '/etc/hubium/Caddyfile',
    /** Shared with the web server: its calls to the control API carry this. */
    controlKey: env.APP_SECRET ?? '',
  };
}

export type AgentSettings = ReturnType<typeof agentSettings>;
