import { parseArgs } from 'node:util';
import { ensureSystemContext } from '@hubium/core';
import {
  createNode,
  listNodes,
  newNodeCode,
  REGISTRATION_HOURS,
  revokeNode,
} from '@hubium/core/node/nodes';
import type { Io } from './main.ts';
import { UsageError } from './main.ts';
import { systemCtx, withDb } from './system.ts';

/**
 * `hubium nodes`, in the cloud: the local nodes of branches and buildings. `add` prints the
 * installation code `install-hubium.sh --node` takes on the node's server.
 */
export async function nodesCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      categories: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const [action = 'list', id] = positionals;
  return withDb(async (db) => {
    await ensureSystemContext(db);
    const ctx = await systemCtx(db);
    if (action === 'add') {
      if (!values.name) throw new UsageError('nodes add needs --name, e.g. --name "Branch 2".');
      const categoryIds = values.categories ? values.categories.split(',').filter(Boolean) : [];
      const r = await createNode.run(ctx, { name: values.name, categoryIds });
      if (values.json) io.out(JSON.stringify(r));
      else {
        io.out(`Node ${values.name} added (${r.id}).`);
        io.out(`Installation code, valid ${REGISTRATION_HOURS} hours: ${r.code}`);
      }
      return 0;
    }
    if (action === 'code' || action === 'revoke') {
      if (!id) throw new UsageError(`nodes ${action} needs the node's id.`);
      if (action === 'revoke') {
        await revokeNode.run(ctx, { id });
        io.out('The node is revoked: it gets nothing more from this server.');
      } else {
        const r = await newNodeCode.run(ctx, { id });
        if (values.json) io.out(JSON.stringify(r));
        else io.out(`Installation code, valid ${REGISTRATION_HOURS} hours: ${r.code}`);
      }
      return 0;
    }
    if (action !== 'list') throw new UsageError(`Unknown action "nodes ${action}".`);
    const nodes = await listNodes(ctx);
    if (values.json) io.out(JSON.stringify(nodes));
    else if (!nodes.length) io.out('No nodes.');
    else
      for (const n of nodes)
        io.out(
          `${n.id}  ${n.name}  ${n.revokedAt ? 'revoked' : n.installed ? n.mode : 'not installed'}` +
            `${n.lastSeenAt ? `  last seen ${n.lastSeenAt.toISOString()}` : ''}`,
        );
    return 0;
  });
}
