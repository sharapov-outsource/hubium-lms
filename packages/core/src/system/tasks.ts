import { type Db, Prisma } from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { NotFoundError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { enqueue, getBoss } from '../jobs/jobs.ts';
import { listModules } from '../modules/registry.ts';

// Administration → Tasks, like Moodle's scheduled task list and task log: what the worker
// runs on a schedule, how each run went (pg-boss keeps the jobs), and "run now" / "retry".

/** Core scheduled jobs and their cron (UTC); the worker schedules them from this list. */
export const CORE_SCHEDULE = {
  // proves to Admin → Environment and /api/metrics that scheduled jobs run
  'system.heartbeat': '* * * * *',
  // users get their digest at their own local hour
  'email.digest': '0 * * * *',
  'announcements.publish': '* * * * *',
  'calendar.reminders': '10 * * * *',
  // each subscription is refreshed when its own interval has passed
  'calendar.subscriptions': '25 * * * *',
  // badges earned by grades and cohorts, which completion events do not cover
  'badges.review': '35 * * * *',
  // members of the cohorts linked to learning plan templates get their plans
  'competency.plans.sync': '50 * * * *',
  // custom reports emailed on their schedules
  'reports.schedules': '*/15 * * * *',
  'enrol.expire': '5 * * * *',
  'notifications.prune': '41 4 * * *',
  'webhooks.prune': '29 4 * * *',
  'files.gc': '17 3 * * *',
  // courses and activities kept in the recycle bin long enough
  'recyclebin.purge': '7 3 * * *',
  'auth.ldapSync': '47 2 * * *',
  'auth.sessions.cleanup': '23 * * * *',
} as const;

export type CoreScheduledJob = keyof typeof CORE_SCHEDULE;

/** How long finished jobs stay in pg-boss: the task log goes back as far. */
export const TASK_LOG_DAYS = 30;

export interface ScheduledTask {
  name: string;
  cron: string;
  /** The activity type that defines it; core tasks have none. */
  module: string | null;
}

/** Core tasks first, then those of the activity types, by name. */
export function scheduledTasks(): ScheduledTask[] {
  const core = Object.entries(CORE_SCHEDULE).map(([name, cron]) => ({ name, cron, module: null }));
  const modules = listModules()
    .flatMap((m) => (m.cron ?? []).map((c) => ({ name: c.name, cron: c.schedule, module: m.key })))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...core, ...modules];
}

export type TaskState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';

export interface TaskRun {
  id: string;
  name: string;
  state: TaskState;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Milliseconds from start to finish. */
  durationMs: number | null;
  retries: number;
  /** The failure's message. */
  error: string | null;
}

interface JobRow {
  id: string;
  name: string;
  state: TaskState;
  created_on: Date;
  started_on: Date | null;
  completed_on: Date | null;
  retry_count: number;
  output: unknown;
}

function toRun(r: JobRow): TaskRun {
  const out = r.output as { message?: unknown } | null;
  return {
    id: r.id,
    name: r.name,
    state: r.state,
    createdAt: r.created_on,
    startedAt: r.started_on,
    completedAt: r.completed_on,
    durationMs:
      r.started_on && r.completed_on ? r.completed_on.getTime() - r.started_on.getTime() : null,
    retries: r.retry_count,
    error: r.state === 'failed' && out && typeof out.message === 'string' ? out.message : null,
  };
}

/** pg-boss has not created its tables yet (a fresh install before the worker started). */
const noBoss = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && /does not exist/.test(e.message);

/** Scheduled tasks with their last run and last failure. */
export async function taskOverview(ctx: RequestContext) {
  await ctx.perm.require('site:config');
  const tasks = scheduledTasks();
  const names = tasks.map((t) => t.name);
  const [last, failed] = await Promise.all([
    lastRuns(ctx.db, names, Prisma.sql`started_on IS NOT NULL`),
    lastRuns(ctx.db, names, Prisma.sql`state = 'failed'`),
  ]);
  return tasks.map((t) => ({
    ...t,
    last: last.get(t.name) ?? null,
    lastFailure: failed.get(t.name) ?? null,
  }));
}

async function lastRuns(db: Db, names: string[], where: Prisma.Sql) {
  const rows = await db.$queryRaw<JobRow[]>`
      SELECT DISTINCT ON (name) id::text, name, state::text AS state, created_on, started_on,
        completed_on, retry_count, output
      FROM pgboss.job
      WHERE name = ANY(${names}) AND ${where}
      ORDER BY name, created_on DESC`.catch((e) => {
    if (noBoss(e)) return [] as JobRow[];
    throw e;
  });
  return new Map(rows.map((r) => [r.name, toRun(r)]));
}

export const TaskLogQuery = z.object({
  name: z.string().max(200).optional(),
  state: z.enum(['created', 'retry', 'active', 'completed', 'cancelled', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Jobs of the last TASK_LOG_DAYS days, newest first; scheduled and one-off alike. */
export async function taskLog(ctx: RequestContext, raw: z.input<typeof TaskLogQuery>) {
  await ctx.perm.require('site:config');
  const q = TaskLogQuery.parse(raw);
  const where = Prisma.sql`created_on > now() - make_interval(days => ${TASK_LOG_DAYS})
    ${q.name ? Prisma.sql`AND name = ${q.name}` : Prisma.empty}
    ${q.state ? Prisma.sql`AND state = ${q.state}::pgboss.job_state` : Prisma.empty}`;
  try {
    const [rows, count, names] = await Promise.all([
      ctx.db.$queryRaw<JobRow[]>`
        SELECT id::text, name, state::text AS state, created_on, started_on, completed_on,
          retry_count, output
        FROM pgboss.job WHERE ${where}
        ORDER BY created_on DESC
        LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      ctx.db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pgboss.job WHERE ${where}`,
      ctx.db.$queryRaw<{ name: string }[]>`SELECT name FROM pgboss.queue ORDER BY name`,
    ]);
    return {
      items: rows.map(toRun),
      total: Number(count[0]?.n ?? 0),
      page: q.page,
      pageSize: q.pageSize,
      names: names.map((n) => n.name),
    };
  } catch (e) {
    if (noBoss(e)) return { items: [], total: 0, page: q.page, pageSize: q.pageSize, names: [] };
    throw e;
  }
}

/** Queues a scheduled task to run as soon as the worker gets to it. */
export async function runTaskNow(ctx: RequestContext, name: string) {
  await ctx.perm.require('site:config');
  if (!scheduledTasks().some((t) => t.name === name)) throw new NotFoundError('Task');
  const id = await enqueue(name, {}, { retryLimit: 0 });
  await logEvent(ctx.db, {
    name: 'task.run',
    actorId: ctx.perm.userId,
    objectType: 'task',
    data: { task: name },
    origin: ctx.origin,
  });
  return { id };
}

/** Puts a failed job back in the queue; it runs again with the same data. */
export async function retryTaskRun(ctx: RequestContext, input: { name: string; id: string }) {
  await ctx.perm.require('site:config');
  const boss = await getBoss();
  // pg-boss types the answer as an empty interface; it carries the count
  const r = (await boss.retry(input.name, input.id)) as { affected?: number };
  if (!r.affected) throw new NotFoundError('Failed job');
  await logEvent(ctx.db, {
    name: 'task.retried',
    actorId: ctx.perm.userId,
    objectType: 'task',
    data: { task: input.name, jobId: input.id },
    origin: ctx.origin,
  });
  return { ok: true };
}
