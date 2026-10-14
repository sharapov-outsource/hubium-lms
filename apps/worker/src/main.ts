import './service.ts';
import { createServer } from 'node:http';
import {
  ensureSystemContext,
  startCacheListener,
  syncCapabilities,
  TASK_LOG_DAYS,
} from '@hubium/core';
import { getBoss, stopBoss } from '@hubium/core/jobs/jobs';
import { getDb } from '@hubium/db';
import { log } from '@hubium/log';
import { shutdownTelemetry, startTelemetry } from '@hubium/telemetry';
import type { JobHandlerDef } from './handlers.ts';
import { allHandlers } from './registry.ts';

// Worker process: runs pg-boss consumers and cron schedules for the queues listed in
// WORKER_QUEUES (default | media) and exposes /healthz for compose.

const roles = (process.env.WORKER_QUEUES ?? 'default').split(',').map((s) => s.trim());
// before the first query; jobs run in pg-boss's "process" spans (see getBoss)
startTelemetry({ service: process.env.HUBIUM_SERVICE ?? 'worker', fetch: true });
const db = getDb();
const logger = log('worker');
const jobs = log('jobs');
let healthy = false;
const KEEP_SECONDS = TASK_LOG_DAYS * 86_400;

/**
 * Runs one job and logs it: done at debug level, failures at error (or warn for failures
 * the job expects to be retried, such as an unreachable webhook receiver).
 */
async function run(def: JobHandlerDef, job: { id: string; data: unknown }) {
  const started = performance.now();
  const fields = () => ({
    job: def.name,
    jobId: job.id,
    ms: Math.round(performance.now() - started),
  });
  try {
    const out = await def.handler(job.data as never, { db, jobId: job.id });
    jobs.debug(fields(), 'job done');
    return out;
  } catch (e) {
    const expected = (e as { expected?: boolean }).expected === true;
    jobs[expected ? 'warn' : 'error']({ ...fields(), err: e }, 'job failed');
    throw e;
  }
}

async function main() {
  await ensureSystemContext(db);
  await syncCapabilities(db);
  await startCacheListener();
  const boss = await getBoss({ role: 'worker' });
  for (const def of allHandlers.filter((h) => roles.includes(h.queue ?? 'default'))) {
    // finished jobs stay as long as Administration → Tasks shows them
    const queue = await boss.getQueue(def.name);
    if (!queue) await boss.createQueue(def.name, { deleteAfterSeconds: KEEP_SECONDS });
    else if (queue.deleteAfterSeconds !== KEEP_SECONDS)
      await boss.updateQueue(def.name, { deleteAfterSeconds: KEEP_SECONDS });
    await boss.work(def.name, { batchSize: def.batchSize ?? 1 }, async (batch) => {
      if (batch.length === 1) return run(def, batch[0]!);
      // A batch is settled job by job: one failure must not retry (and so repeat, e.g.
      // re-send) the jobs that already succeeded.
      for (const job of batch) {
        try {
          const out = await run(def, job);
          await boss.complete(def.name, job.id, (out ?? null) as object | null);
        } catch (e) {
          await boss.fail(def.name, job.id, {
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    });
    if (def.cron) await boss.schedule(def.name, def.cron, {}, { tz: 'UTC' });
    logger.debug({ job: def.name, cron: def.cron }, 'handler registered');
  }
  healthy = true;
  logger.info(
    { queues: roles, version: process.env.HUBIUM_VERSION, commit: process.env.HUBIUM_COMMIT },
    'worker started',
  );
}

const port = Number(process.env.WORKER_HEALTH_PORT ?? 3001);
createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'starting' }));
    return;
  }
  res.writeHead(404).end();
}).listen(port);

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker stopping');
  healthy = false;
  await stopBoss();
  await db.$disconnect();
  await shutdownTelemetry();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((e) => {
  logger.fatal({ err: e }, 'worker failed to start');
  process.exit(1);
});
