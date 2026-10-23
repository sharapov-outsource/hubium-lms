import { localStorageFile } from '@hubium/core/files/storage';
import type { NodeReplicas } from '@hubium/core/node/replicas';
import { log } from '@hubium/log';
import { CloudError, cloudCall, cloudUpload } from './cloud.ts';
import type { AgentSettings } from './settings.ts';

// The sync: the journal the node kept while it worked alone goes to the cloud in order,
// in batches, each entry's files first. The cloud does each entry once (by its id), so a
// sync cut off by another outage just starts again. What the cloud did with each entry is
// written back to the journal.

const logger = log('node-sync');
const BATCH = 100;

interface JournalRow {
  id: string;
  seq: string;
  kind: string;
  name: string;
  version: string;
  activityId: string | null;
  actor: unknown;
  input: unknown;
  ip: string | null;
  at: Date;
  seed: string;
  ids: unknown;
  guards: unknown;
  files: string[];
  uploads: unknown;
}

interface ReplayAnswer {
  results: { id: string; status: 'APPLIED' | 'CONFLICT' | 'REJECTED'; error?: string }[];
  lsn: string;
}

export async function syncJournal(
  s: AgentSettings,
  replicas: NodeReplicas,
): Promise<{ done: boolean; lsn?: string }> {
  const b = replicas.ownDatabase;
  if (!b) return { done: true, lsn: (await cloudCall<{ lsn: string }>(s, 'GET', 'lsn')).lsn };
  let lsn: string | undefined;
  const sent = new Set<string>();
  for (;;) {
    const { rows } = await b.query<JournalRow>(
      `SELECT id, seq::text, kind, name, version, "activityId", actor, input, ip, at, seed, ids,
              guards, files, uploads
         FROM "NodeOp" WHERE status = 'PENDING' ORDER BY seq LIMIT $1`,
      [BATCH],
    );
    if (!rows.length) break;
    // the files of the batch first: the entries refer to them
    for (const key of rows.flatMap((r) => r.files)) {
      if (sent.has(key)) continue;
      const file = await localStorageFile(key);
      if (file) await cloudUpload(s, key, file);
      sent.add(key);
    }
    let answer: ReplayAnswer;
    try {
      answer = await cloudCall<ReplayAnswer>(
        s,
        'POST',
        'replay',
        { ops: rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() })) },
        120_000,
      );
    } catch (err) {
      // another node's journal goes first
      if (err instanceof CloudError && err.status === 409) return { done: false };
      throw err;
    }
    for (const r of answer.results)
      await b.query(`UPDATE "NodeOp" SET status = $2::"NodeOpStatus", error = $3 WHERE id = $1`, [
        r.id,
        r.status,
        r.error ?? null,
      ]);
    lsn = answer.lsn;
    const counts: Record<string, number> = {};
    for (const r of answer.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    logger.info({ ...counts }, 'journal batch taken by the cloud');
  }
  lsn ??= (await cloudCall<{ lsn: string }>(s, 'GET', 'lsn')).lsn;
  return { done: true, lsn };
}
