import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Db } from '@hubium/db';
import { getEnv } from '../env.ts';
import { antivirusVersion } from '../files/antivirus.ts';
import { getStorage } from '../files/storage.ts';
import { getTransport } from '../mail/mail.ts';
import { pushConfig } from '../notifications/push.ts';
import { getSetting } from '../settings/settings.ts';

// Operational checks for Admin → Environment and the Prometheus endpoint.

const HEARTBEAT_KEY = 'worker.heartbeat';

/** Worker cron: proves that scheduled jobs run. */
export async function recordHeartbeat(db: Db, now = new Date()) {
  await db.siteSetting.upsert({
    where: { key: HEARTBEAT_KEY },
    create: { key: HEARTBEAT_KEY, value: now.toISOString() },
    update: { value: now.toISOString() },
  });
  return { at: now.toISOString() };
}

export async function lastHeartbeat(db: Db): Promise<Date | null> {
  const row = await db.siteSetting.findUnique({ where: { key: HEARTBEAT_KEY } });
  return typeof row?.value === 'string' ? new Date(row.value) : null;
}

export type CheckStatus = 'ok' | 'warn' | 'error';
export interface EnvCheck {
  key: string;
  status: CheckStatus;
  detail: string;
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);

const ffmpegVersion = () =>
  new Promise<string>((resolve, reject) =>
    execFile(
      /*turbopackIgnore: true*/ process.env.FFMPEG_PATH ?? 'ffmpeg',
      ['-version'],
      { timeout: 3000 },
      (err, out) => (err ? reject(err) : resolve(out.split('\n')[0] ?? '')),
    ),
  );

/** Each check is independent and never throws. */
export async function environmentChecks(db: Db, now = new Date()): Promise<EnvCheck[]> {
  const env = getEnv();
  const run = async (key: string, fn: () => Promise<[CheckStatus, string]>): Promise<EnvCheck> => {
    try {
      const [status, detail] = await fn();
      return { key, status, detail };
    } catch (e) {
      return { key, status: 'error', detail: e instanceof Error ? e.message : String(e) };
    }
  };
  return Promise.all([
    run('database', async () => {
      const [r] = await db.$queryRaw<{ v: string; vector: boolean }[]>`
        SELECT current_setting('server_version') AS v,
               EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector`;
      return r!.vector
        ? ['ok', `PostgreSQL ${r!.v}, pgvector`]
        : ['warn', `PostgreSQL ${r!.v}, no pgvector`];
    }),
    run('worker', async () => {
      const at = await lastHeartbeat(db);
      if (!at) return ['error', 'no heartbeat yet — is the worker running?'];
      const age = Math.round((now.getTime() - at.getTime()) / 1000);
      return [age < 180 ? 'ok' : 'error', `last heartbeat ${age}s ago`];
    }),
    run('jobs', async () => {
      const [r] = await db.$queryRaw<{ queued: bigint; failed: bigint }[]>`
        SELECT count(*) FILTER (WHERE state IN ('created', 'retry')) AS queued,
               count(*) FILTER (WHERE state = 'failed' AND completed_on > now() - interval '24 hours') AS failed
        FROM pgboss.job`;
      const failed = Number(r!.failed);
      return [failed > 0 ? 'warn' : 'ok', `${Number(r!.queued)} queued, ${failed} failed in 24h`];
    }),
    run('storage', async () => {
      const key = `health/${randomUUID()}`;
      const s = getStorage();
      await s.put(key, Buffer.from('ok'), 'text/plain');
      await s.delete(key);
      return ['ok', `${s.kind} writable`];
    }),
    run('smtp', async () => {
      await withTimeout(getTransport().verify(), 5000);
      return ['ok', env.SMTP_URL.replace(/\/\/[^@]*@/, '//***@')];
    }),
    run('contentOrigin', async () => {
      const app = new URL(env.APP_URL).host;
      const content = env.CONTENT_HOST ? new URL(env.CONTENT_HOST).host : app;
      if (content !== app) return ['ok', `SCORM content on ${content}`];
      return [
        env.NODE_ENV === 'production' ? 'error' : 'warn',
        'CONTENT_HOST is not a separate origin',
      ];
    }),
    run('antivirus', async () => {
      if (!env.CLAMAV_URL) return ['ok', 'off (CLAMAV_URL is not set; uploads are not scanned)'];
      try {
        return ['ok', await antivirusVersion(env)];
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return ['error', `clamd unreachable, uploads are refused: ${why}`];
      }
    }),
    run('push', async () =>
      pushConfig()
        ? ['ok', 'VAPID keys configured']
        : ['warn', 'Web Push disabled (no VAPID keys)'],
    ),
    run('ai', async () => {
      if (!(await getSetting(db, 'ai.enabled'))) return ['ok', 'disabled'];
      const n = await db.aiFeatureConfig.count({
        where: { enabled: true, providerId: { not: null } },
      });
      return n
        ? ['ok', `${n} feature(s) enabled`]
        : ['warn', 'enabled but no feature has a provider'];
    }),
    run('ffmpeg', async () => {
      try {
        return ['ok', await ffmpegVersion()];
      } catch {
        return ['warn', 'not found here (needed on the media worker)'];
      }
    }),
  ]);
}

/** Prometheus text exposition of a few business and queue gauges. */
export async function prometheusMetrics(db: Db): Promise<string> {
  const [counts] = await db.$queryRaw<
    {
      users: bigint;
      active: bigint;
      courses: bigint;
      mail: bigint;
      ai: bigint;
      ai_tokens: bigint | null;
    }[]
  >`SELECT
      (SELECT count(*) FROM "User" WHERE "deletedAt" IS NULL AND kind = 'PERSON') AS users,
      (SELECT count(*) FROM "User" WHERE "lastLoginAt" > now() - interval '1 day') AS active,
      (SELECT count(*) FROM "Course" WHERE "deletedAt" IS NULL) AS courses,
      (SELECT count(*) FROM "Notification" WHERE "emailState" = 'PENDING') AS mail,
      (SELECT count(*) FROM "AiUsage" WHERE "createdAt" > now() - interval '1 day') AS ai,
      (SELECT sum("inputTokens" + "outputTokens") FROM "AiUsage" WHERE "createdAt" > now() - interval '1 day') AS ai_tokens`;
  const queues = await db.$queryRaw<{ name: string; state: string; n: bigint }[]>`
      SELECT name, state::text AS state, count(*) AS n FROM pgboss.job
      WHERE state IN ('created', 'retry', 'active', 'failed') GROUP BY name, state`.catch(() => []);
  const hb = await lastHeartbeat(db);
  const nodes = await nodeMetrics(db);
  const c = counts!;
  const lines = [
    '# HELP hubium_users Registered people (not deleted).',
    '# TYPE hubium_users gauge',
    `hubium_users ${Number(c.users)}`,
    '# HELP hubium_users_active_1d Users who signed in during the last day.',
    '# TYPE hubium_users_active_1d gauge',
    `hubium_users_active_1d ${Number(c.active)}`,
    '# TYPE hubium_courses gauge',
    `hubium_courses ${Number(c.courses)}`,
    '# HELP hubium_mail_pending Notification emails waiting to be sent.',
    '# TYPE hubium_mail_pending gauge',
    `hubium_mail_pending ${Number(c.mail)}`,
    '# TYPE hubium_ai_requests_1d gauge',
    `hubium_ai_requests_1d ${Number(c.ai)}`,
    '# TYPE hubium_ai_tokens_1d gauge',
    `hubium_ai_tokens_1d ${Number(c.ai_tokens ?? 0)}`,
    '# HELP hubium_worker_heartbeat_age_seconds Seconds since the worker cron last ran.',
    '# TYPE hubium_worker_heartbeat_age_seconds gauge',
    `hubium_worker_heartbeat_age_seconds ${hb ? Math.round((Date.now() - hb.getTime()) / 1000) : -1}`,
    '# HELP hubium_jobs Background jobs by queue and state.',
    '# TYPE hubium_jobs gauge',
    ...queues.map(
      (q) => `hubium_jobs{queue="${q.name.replace(/"/g, '')}",state="${q.state}"} ${Number(q.n)}`,
    ),
    ...nodes,
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${process.memoryUsage().rss}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** The local nodes: since their last heartbeat, how far their replica is, what waits. */
async function nodeMetrics(db: Db): Promise<string[]> {
  const nodes = await db.node.findMany({
    where: { revokedAt: null, tokenHash: { not: null } },
    select: {
      id: true,
      name: true,
      mode: true,
      lastSeenAt: true,
      status: true,
      _count: { select: { conflicts: { where: { status: 'OPEN' } } } },
    },
  });
  if (!nodes.length) return [];
  const label = (n: { id: string; name: string }) =>
    `node="${n.id}",name="${n.name.replace(/["\\\n]/g, ' ')}"`;
  const status = (n: { status: unknown }) =>
    (n.status ?? {}) as { lagBytes?: number | null; pendingOps?: number };
  return [
    '# HELP hubium_node_heartbeat_age_seconds Seconds since a local node was last heard.',
    '# TYPE hubium_node_heartbeat_age_seconds gauge',
    ...nodes.map(
      (n) =>
        `hubium_node_heartbeat_age_seconds{${label(n)}} ${n.lastSeenAt ? Math.round((Date.now() - n.lastSeenAt.getTime()) / 1000) : -1}`,
    ),
    '# HELP hubium_node_mode A local node in its mode (1).',
    '# TYPE hubium_node_mode gauge',
    ...nodes.map((n) => `hubium_node_mode{${label(n)},mode="${n.mode}"} 1`),
    '# HELP hubium_node_replica_lag_bytes How far the replica of a node is behind, in bytes of WAL.',
    '# TYPE hubium_node_replica_lag_bytes gauge',
    ...nodes.map((n) => `hubium_node_replica_lag_bytes{${label(n)}} ${status(n).lagBytes ?? -1}`),
    '# HELP hubium_node_journal_pending Journal entries of a node the cloud has not taken.',
    '# TYPE hubium_node_journal_pending gauge',
    ...nodes.map((n) => `hubium_node_journal_pending{${label(n)}} ${status(n).pendingOps ?? 0}`),
    '# HELP hubium_node_conflicts_open Work done on a node without a connection, not taken.',
    '# TYPE hubium_node_conflicts_open gauge',
    ...nodes.map((n) => `hubium_node_conflicts_open{${label(n)}} ${n._count.conflicts}`),
  ];
}
