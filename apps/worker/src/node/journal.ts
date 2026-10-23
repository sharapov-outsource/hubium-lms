import { pendingJournal, runningTimedAttempts } from '@hubium/core/node/journal-db';
import type { NodeReplicas } from '@hubium/core/node/replicas';

/** The journal on the node's own database, while the node uses it (else nothing to tell). */
export function journal(replicas: NodeReplicas) {
  const own = async () =>
    (await replicas.replicaB()) === 'promoted' ? replicas.ownDatabase : null;
  return {
    async pending() {
      const b = await own();
      return b ? pendingJournal(b) : 0;
    },
    async runningTimedAttempts() {
      const b = await own();
      return b ? runningTimedAttempts(b) : 0;
    },
  };
}
