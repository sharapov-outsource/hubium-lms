// A local node runs the same release as the cloud with HUBIUM_ROLE=node: its web server reads
// a replica of the cloud's database and its agent (the worker in the node role) passes
// changes on to the cloud, or works on its own while the link is down (docs/architecture.md
// §1.7). These are the settings the installer writes from the cloud's registration answer.

export interface NodeConfig {
  id: string;
  /** The token of the node API; requests passed on to the cloud are signed with its hash. */
  token: string;
  /** The cloud's address: APP_URL of the cloud, the same name the people here use. */
  hubUrl: string;
  /**
   * Where that name is reached from the node, when the network here sends it to the node
   * itself (split-horizon DNS): an IP address or another name of the cloud.
   */
  hubAddress?: string;
  /** The agent's address for the node's web server (state, side records, the event stream). */
  agentUrl: string;
  /** The database the node falls back to without a connection (B). */
  databaseBUrl?: string;
}

/** Whether this process belongs to a local node. */
export function isNode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HUBIUM_ROLE === 'node';
}

/** The node's settings; throws in a node with a setting missing. */
export function nodeConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required with HUBIUM_ROLE=node`);
    return v;
  };
  return {
    id: need('NODE_ID'),
    token: need('NODE_TOKEN'),
    hubUrl: need('NODE_HUB_URL').replace(/\/+$/, ''),
    hubAddress: env.NODE_HUB_ADDRESS || undefined,
    agentUrl: (env.NODE_AGENT_URL || 'http://127.0.0.1:3002').replace(/\/+$/, ''),
    databaseBUrl: env.NODE_DATABASE_B_URL || undefined,
  };
}

/**
 * The release, which a node must run too: the same version and commit. Read as
 * process.env.X literally: the bundlers of web and worker put the build's values there.
 */
export function releaseId(): string {
  return `${process.env.HUBIUM_VERSION || '0.0.0'}+${process.env.HUBIUM_COMMIT || 'dev'}`;
}
