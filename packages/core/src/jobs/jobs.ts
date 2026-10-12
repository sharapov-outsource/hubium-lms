import type { Prisma } from '@hubium/db';
import { fromPrisma, PgBoss, type SendOptions } from 'pg-boss';

// pg-boss wrapper. The web app only enqueues (no supervision, no cron); the worker
// process runs maintenance, schedules and handlers.

export interface JobPayloads {
  'email.send': { to: string; subject: string; html: string; text: string; template?: string };
  [name: string]: object;
}
export type JobName = keyof JobPayloads & string;

export const coreQueues: JobName[] = ['email.send'];

let bossPromise: Promise<PgBoss> | undefined;
const createdQueues = new Set<string>();

export function getBoss(
  opts: { role?: 'producer' | 'worker'; connectionString?: string } = {},
): Promise<PgBoss> {
  bossPromise ??= (async () => {
    const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    const worker = opts.role === 'worker';
    const boss = new PgBoss({
      connectionString,
      schema: 'pgboss',
      max: worker ? 10 : 3,
      supervise: worker,
      schedule: worker,
      migrate: true,
    });
    boss.on('error', (e) => console.error('[pg-boss]', e));
    await boss.start();
    return boss;
  })().catch((e) => {
    bossPromise = undefined;
    throw e;
  });
  return bossPromise;
}

export async function ensureQueue(
  name: string,
  options?: Parameters<PgBoss['createQueue']>[1],
): Promise<void> {
  if (createdQueues.has(name)) return;
  const boss = await getBoss();
  if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
  createdQueues.add(name);
}

/**
 * Enqueues a job. Pass `tx` to enqueue inside a Prisma transaction: the job becomes
 * visible only if the transaction commits (transactional outbox).
 */
export async function enqueue<N extends JobName>(
  name: N,
  data: JobPayloads[N],
  opts: SendOptions & { tx?: Prisma.TransactionClient } = {},
): Promise<string | null> {
  const { tx, ...sendOpts } = opts;
  await ensureQueue(name);
  const boss = await getBoss();
  return boss.send(name, data, {
    retryLimit: 5,
    retryBackoff: true,
    ...sendOpts,
    ...(tx ? { db: fromPrisma(tx) } : {}),
  });
}

export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const boss = await bossPromise;
  bossPromise = undefined;
  createdQueues.clear();
  await boss.stop({ graceful: true, timeout: 10_000 });
}
