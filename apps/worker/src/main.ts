import { createServer } from 'node:http';
import { ensureSystemContext, startCacheListener, syncCapabilities } from '@hubium/core';
import { getBoss, stopBoss } from '@hubium/core/jobs/jobs';
import { getDb } from '@hubium/db';
import { allHandlers } from './registry.ts';

// Worker process: runs pg-boss consumers and cron schedules for the queues listed in
// WORKER_QUEUES (default | media) and exposes /healthz for compose.

const roles = (process.env.WORKER_QUEUES ?? 'default').split(',').map((s) => s.trim());
const db = getDb();
let healthy = false;

async function main() {
  await ensureSystemContext(db);
  await syncCapabilities(db);
  await startCacheListener();
  const boss = await getBoss({ role: 'worker' });
  for (const def of allHandlers.filter((h) => roles.includes(h.queue ?? 'default'))) {
    if (!(await boss.getQueue(def.name))) await boss.createQueue(def.name);
    await boss.work(def.name, { batchSize: def.batchSize ?? 1 }, async (jobs) => {
      if (jobs.length === 1) {
        const [job] = jobs;
        return def.handler(job!.data as never, { db, jobId: job!.id });
      }
      // A batch is settled job by job: one failure must not retry (and so repeat, e.g.
      // re-send) the jobs that already succeeded.
      for (const job of jobs) {
        try {
          const out = await def.handler(job.data as never, { db, jobId: job.id });
          await boss.complete(def.name, job.id, (out ?? null) as object | null);
        } catch (e) {
          console.error(`[worker] ${def.name} ${job.id} failed`, e);
          await boss.fail(def.name, job.id, {
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    });
    if (def.cron) await boss.schedule(def.name, def.cron, {}, { tz: 'UTC' });
    console.log(`[worker] ${def.name}${def.cron ? ` (cron ${def.cron})` : ''}`);
  }
  healthy = true;
  console.log(`[worker] started; queues: ${roles.join(', ')}`);
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
  console.log(`[worker] ${signal}, stopping…`);
  healthy = false;
  await stopBoss();
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((e) => {
  console.error('[worker] failed to start', e);
  process.exit(1);
});
